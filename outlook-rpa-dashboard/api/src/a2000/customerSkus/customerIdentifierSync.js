import { supabase } from '../../supabase.js';
import { A2000RestClient } from '../restClient.js';
import {
  buildCustomerSkuUploadRow,
  customerIdentifierPayloadHash,
  explicitCustomerIdentifierSets,
  resolveA2000Size
} from './explicitIdentifierCore.js';

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function boolEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'y'].includes(
    String(value).toLowerCase()
  );
}

function escapeLiteral(value) {
  return clean(value).replaceAll("'", "''");
}

function uploadSuccess(result, expectedRows) {
  const raw = String(result?.rawBody || '');
  const body = result?.body;
  const status = body?.status || (
    /"status"\s*:\s*"Success"/i.test(raw)
      ? 'Success'
      : null
  );
  const updatedMatch = raw.match(/"updated"\s*:\s*(\d+)/i);
  const errorsMatch = raw.match(/"errors"\s*:\s*(\d+)/i);
  const updated = Number(
    body?.updated
    ?? updatedMatch?.[1]
    ?? 0
  );
  const errors = Number(
    typeof body?.errors === 'number'
      ? body.errors
      : errorsMatch?.[1] ?? 0
  );

  return {
    ok: (
      result?.httpStatus === 200
      && status === 'Success'
      && updated >= expectedRows
      && errors === 0
    ),
    status,
    updated,
    errors,
    response_json_valid: Boolean(body),
    raw_body: raw
  };
}

export function customerSkuAutoUploadEnabled() {
  return boolEnv(
    process.env.A2000_CUSTOMER_SKU_AUTO_UPLOAD_ENABLED,
    true
  );
}

async function orderById(orderId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('id', orderId)
    .single();

  if (error) throw error;
  return data;
}

async function ordersByDocument(documentId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('document_id', documentId)
    .order('order_no', { ascending: true });

  if (error) throw error;
  return data || [];
}

async function recentParsedOrders({ limit = 200 } = {}) {
  let query = supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('status', 'parsed')
    .order('created_at', { ascending: false })
    .limit(limit);

  const after = clean(
    process.env.A2000_CUSTOMER_SKU_AUTO_UPLOAD_AFTER
  );
  if (after) query = query.gte('created_at', after);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function persistAudit(order, audit) {
  try {
    const rawJson = (
      order.raw_json
      && typeof order.raw_json === 'object'
    ) ? order.raw_json : {};

    await supabase
      .from('purchase_orders')
      .update({
        raw_json: {
          ...rawJson,
          customer_identifier_sync: audit
        }
      })
      .eq('id', order.id);
  } catch {
    // Preserve the original business result if optional audit persistence fails.
  }
}

function currentSuccessfulHash(order = {}) {
  const audit = order.raw_json?.customer_identifier_sync;
  return audit?.response?.ok === true
    ? clean(audit.payload_sha256)
    : '';
}

async function masterRowsForIdentity(client, style, color, cache) {
  const key = `${style}|${color}`;
  if (cache.has(key)) return cache.get(key);

  const [skuResult, sizeResult] = await Promise.all([
    client.viewer('VR_SKU', {
      columns: [
        'STYLE',
        'CLR',
        'STYLE_DESCR',
        'CLR_DESC',
        'CLR_ABBR',
        'SKU',
        'SKU_DESCR',
        'SCALE',
        'SCALE_ABBR',
        'SCALE_PACK_QTY',
        'PACK_QTY',
        'CUSTOMER',
        'DIV'
      ],
      filter: (
        `STYLE = '${escapeLiteral(style)}' `
        + `AND CLR = '${escapeLiteral(color)}'`
      ),
      sort: 'STYLE,CLR'
    }),
    client.viewer('VR_UPC_STYLE', {
      columns: [
        'UPC_NO',
        'STYLE',
        'CLR',
        'SIZE_NUM',
        'SIZE_NAME',
        'NRF_SIZE',
        'SKU',
        'SKU_DESCR',
        'PACK_QTY',
        'SCALE_PACK_QTY'
      ],
      filter: (
        `STYLE = '${escapeLiteral(style)}' `
        + `AND CLR = '${escapeLiteral(color)}'`
      ),
      sort: 'SIZE_NUM'
    })
  ]);

  const value = { skuResult, sizeResult };
  cache.set(key, value);
  return value;
}

function mergeUploadRows(rows = []) {
  const byKey = new Map();
  const conflicts = [];

  for (const row of rows) {
    const key = [
      row.CUST_NO,
      row.STYLE,
      row.COLOR_NO,
      row.SIZE_NAME
    ].map(clean).join('|');

    if (!byKey.has(key)) {
      byKey.set(key, row);
      continue;
    }

    const current = byKey.get(key);
    const skuConflict = (
      current.CUST_SKU
      && row.CUST_SKU
      && current.CUST_SKU !== row.CUST_SKU
    );
    const upcConflict = (
      current.CUST_UPC
      && row.CUST_UPC
      && current.CUST_UPC !== row.CUST_UPC
    );

    if (skuConflict || upcConflict) {
      conflicts.push({
        key,
        code: 'CONFLICTING_CUSTOMER_IDENTIFIER_FOR_SAME_MASTER_KEY',
        existing: current,
        incoming: row
      });
      continue;
    }

    byKey.set(key, {
      ...current,
      ...Object.fromEntries(
        Object.entries(row).filter(([, value]) => (
          value !== null
          && value !== undefined
          && String(value).trim() !== ''
        ))
      )
    });
  }

  return {
    rows: [...byKey.values()],
    conflicts
  };
}

export async function preflightCustomerIdentifiers(
  order,
  { client = new A2000RestClient() } = {}
) {
  const candidateRows = [];
  const skipped = [];
  const blocked = [];
  const warnings = [];
  const evidence = [];
  const cache = new Map();

  for (const [index, line] of (
    order.purchase_order_lines || []
  ).entries()) {
    const lineNo = Number(line.line_no || index + 1);
    const identifierSets = explicitCustomerIdentifierSets({
      customerCode: order.customer_code,
      line
    });

    if (!identifierSets.length) {
      skipped.push({
        line_no: lineNo,
        code: 'NO_EXPLICIT_CUSTOMER_IDENTIFIER'
      });
      continue;
    }

    const style = clean(line.style_code);
    const color = clean(line.color_code);

    if (!style || !color) {
      blocked.push({
        line_no: lineNo,
        code: 'A2000_STYLE_COLOR_MISSING'
      });
      continue;
    }

    const { skuResult, sizeResult } = await masterRowsForIdentity(
      client,
      style,
      color,
      cache
    );

    if (skuResult.httpStatus !== 200) {
      blocked.push({
        line_no: lineNo,
        code: 'VR_SKU_HTTP_ERROR',
        http_status: skuResult.httpStatus
      });
      continue;
    }

    if (sizeResult.httpStatus !== 200) {
      blocked.push({
        line_no: lineNo,
        code: 'VR_UPC_STYLE_HTTP_ERROR',
        http_status: sizeResult.httpStatus
      });
      continue;
    }

    for (const identifiers of identifierSets) {
      const effectiveIdentifiers = {
        ...identifiers,
        customer_upc: identifiers.invalid_customer_upc
          ? null
          : identifiers.customer_upc
      };

      if (identifiers.invalid_customer_upc) {
        warnings.push({
          line_no: lineNo,
          code: 'INVALID_EXPLICIT_CUSTOMER_UPC_OMITTED',
          customer_sku_preserved: Boolean(identifiers.customer_sku)
        });
      }

      if (
        !effectiveIdentifiers.customer_sku
        && !effectiveIdentifiers.customer_upc
      ) {
        skipped.push({
          line_no: lineNo,
          code: 'NO_VALID_EXPLICIT_IDENTIFIER_AFTER_VALIDATION'
        });
        continue;
      }

      const sizeResolution = resolveA2000Size({
        skuRows: skuResult.rows,
        sizeRows: sizeResult.rows,
        printedSize: identifiers.printed_size
          || line.size_code
          || line.size_raw
      });

      if (!sizeResolution.valid) {
        blocked.push({
          line_no: lineNo,
          code: sizeResolution.code,
          style,
          color,
          printed_size: identifiers.printed_size || null,
          sku_matches: skuResult.rows.length,
          size_matches: sizeResult.rows.length
        });
        continue;
      }

      const uploadRow = buildCustomerSkuUploadRow({
        order,
        line,
        identifiers: effectiveIdentifiers,
        skuRow: skuResult.rows[0],
        sizeResolution
      });

      if (!uploadRow) {
        skipped.push({
          line_no: lineNo,
          code: 'NO_UPLOAD_ROW'
        });
        continue;
      }

      candidateRows.push(uploadRow);
      evidence.push({
        line_no: lineNo,
        style,
        color,
        customer_sku: effectiveIdentifiers.customer_sku,
        customer_upc: effectiveIdentifiers.customer_upc,
        identifier_provenance: effectiveIdentifiers.provenance,
        size_resolution: sizeResolution,
        internal_sku: skuResult.rows[0]?.SKU || null
      });
    }
  }

  const merged = mergeUploadRows(candidateRows);
  blocked.push(...merged.conflicts);

  const payload = {
    IGNORE_ERRORS: 'N',
    CUST_SKUS: merged.rows
  };
  const payloadSha256 = customerIdentifierPayloadHash(payload);

  return {
    valid: blocked.length === 0,
    uploadable: merged.rows.length > 0 && merged.conflicts.length === 0,
    partial: blocked.length > 0 || warnings.length > 0,
    order_id: order.id,
    order_no: order.order_no,
    customer_code: order.customer_code,
    payload,
    payload_sha256: payloadSha256,
    row_count: merged.rows.length,
    skipped,
    blocked,
    warnings,
    evidence,
    a2000_write_performed: false
  };
}

export async function syncCustomerIdentifiersForOrder(
  orderOrId,
  {
    upload = false,
    client = new A2000RestClient()
  } = {}
) {
  const order = typeof orderOrId === 'object'
    ? orderOrId
    : await orderById(orderOrId);
  const preflight = await preflightCustomerIdentifiers(
    order,
    { client }
  );

  if (!upload) {
    const audit = {
      ...preflight,
      payload: undefined,
      response: null,
      stage: preflight.uploadable
        ? 'customer_identifier_preflight_passed'
        : preflight.row_count
          ? 'customer_identifier_preflight_blocked'
          : 'no_explicit_customer_identifiers',
      created_at: new Date().toISOString()
    };
    await persistAudit(order, audit);
    return {
      ...preflight,
      ok: preflight.valid || preflight.row_count === 0,
      stage: audit.stage,
      upload_requested: false
    };
  }

  if (!preflight.row_count) {
    const result = {
      ...preflight,
      ok: true,
      stage: 'no_explicit_customer_identifiers',
      upload_requested: true
    };
    await persistAudit(order, {
      ...result,
      payload: undefined,
      response: { ok: true, updated: 0, errors: 0 },
      created_at: new Date().toISOString()
    });
    return result;
  }

  if (!preflight.uploadable) {
    return {
      ...preflight,
      ok: false,
      stage: 'customer_identifier_preflight_blocked',
      upload_requested: true
    };
  }

  if (currentSuccessfulHash(order) === preflight.payload_sha256) {
    return {
      ...preflight,
      ok: true,
      stage: 'customer_identifiers_already_synced',
      upload_requested: true,
      idempotent: true,
      a2000_write_performed: false,
      response: {
        ok: true,
        updated: preflight.row_count,
        errors: 0
      }
    };
  }

  client.assertWriteEnvironment();

  const uploadId = clean(
    process.env.A2000_CUSTOMER_SKUS_UPLOAD_ID
    || 'CUST_SKUS'
  );
  const result = await client.upload(
    uploadId,
    preflight.payload
  );
  const parsed = uploadSuccess(result, preflight.row_count);
  const audit = {
    stage: parsed.ok
      ? 'customer_identifiers_uploaded'
      : 'customer_identifier_upload_failed',
    upload_id: uploadId,
    row_count: preflight.row_count,
    payload_sha256: preflight.payload_sha256,
    evidence: preflight.evidence,
    skipped: preflight.skipped,
    blocked: preflight.blocked,
    warnings: preflight.warnings,
    response: parsed,
    a2000_write_performed: parsed.ok,
    sales_order_refresh_required_for_existing_order: parsed.ok,
    created_at: new Date().toISOString()
  };

  await persistAudit(order, audit);

  return {
    ...preflight,
    ok: parsed.ok,
    stage: audit.stage,
    upload_requested: true,
    response: parsed,
    a2000_write_performed: parsed.ok,
    sales_order_refresh_required_for_existing_order: parsed.ok
  };
}

export async function syncCustomerIdentifiersForDocument(
  documentId,
  {
    upload = customerSkuAutoUploadEnabled(),
    client = new A2000RestClient()
  } = {}
) {
  const orders = await ordersByDocument(documentId);
  const results = [];

  for (const order of orders) {
    results.push(await syncCustomerIdentifiersForOrder(
      order,
      { upload, client }
    ));
  }

  return {
    ok: results.every(item => item.ok),
    document_id: documentId,
    upload_requested: upload,
    order_count: orders.length,
    results
  };
}

export async function syncCustomerIdentifiersForDocuments(
  documentIds = [],
  options = {}
) {
  const client = options.client || new A2000RestClient();
  const results = [];

  for (const documentId of documentIds) {
    results.push(await syncCustomerIdentifiersForDocument(
      documentId,
      {
        ...options,
        client
      }
    ));
  }

  return {
    ok: results.every(item => item.ok),
    upload_requested: options.upload === true,
    document_count: documentIds.length,
    results
  };
}

export async function reconcilePendingCustomerIdentifiers({
  limit = Number(
    process.env.A2000_CUSTOMER_SKU_WATCH_ORDER_LIMIT || 200
  ),
  upload = customerSkuAutoUploadEnabled()
} = {}) {
  const orders = await recentParsedOrders({ limit });
  const client = new A2000RestClient();
  const results = [];

  for (const order of orders) {
    try {
      results.push(await syncCustomerIdentifiersForOrder(
        order,
        { upload, client }
      ));
    } catch (error) {
      results.push({
        ok: false,
        order_id: order.id,
        order_no: order.order_no,
        customer_code: order.customer_code,
        stage: 'customer_identifier_sync_error',
        error: error.message
      });
    }
  }

  return {
    ok: results.every(item => item.ok),
    order_count: orders.length,
    uploaded_count: results.filter(
      item => item.stage === 'customer_identifiers_uploaded'
    ).length,
    idempotent_count: results.filter(
      item => item.stage === 'customer_identifiers_already_synced'
    ).length,
    no_identifier_count: results.filter(
      item => item.stage === 'no_explicit_customer_identifiers'
    ).length,
    blocked_count: results.filter(item => !item.ok).length,
    results
  };
}

let watcherTimer = null;
let watcherRunning = false;

export function startCustomerIdentifierWatcher() {
  if (watcherTimer) return watcherTimer;
  if (!boolEnv(process.env.A2000_CUSTOMER_SKU_WATCH_ENABLED, true)) {
    return null;
  }

  const pollMs = Math.max(
    10000,
    Number(
      process.env.A2000_CUSTOMER_SKU_WATCH_POLL_MS || 30000
    )
  );

  const run = async () => {
    if (watcherRunning) return;
    watcherRunning = true;

    try {
      const result = await reconcilePendingCustomerIdentifiers();
      if (result.uploaded_count || result.blocked_count) {
        console.log(
          `[customer-identifiers] uploaded=${result.uploaded_count} `
          + `idempotent=${result.idempotent_count} `
          + `blocked=${result.blocked_count}`
        );
      }
    } catch (error) {
      console.error('[customer-identifiers] error:', error.message);
    } finally {
      watcherRunning = false;
    }
  };

  run();
  watcherTimer = setInterval(run, pollMs);
  watcherTimer.unref?.();
  return watcherTimer;
}
