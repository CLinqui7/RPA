import { supabase } from '../supabase.js';
import { A2000RestAdapter } from '../a2000/restAdapter.js';
import { classifyA2000RuntimeError } from '../a2000/a2000ServiceState.js';
import { buildIdempotencyKey, validateInternalOrder } from '../a2000/restMapper.js';
import { createOrLoadA2000Job, updateA2000Job } from '../a2000/orderJobRepository.js';
import { processDownloadedDocuments } from './poRepository.js';
import { generateChecklistForOrder } from '../checklists/checklistService.js';

const DEFAULT_CERTIFIED_CUSTOMERS = [
  '10BELOW',
  'BEALLSOUTL',
  'CITI',
  'GABRIELBRO',
  'ITSFASHION',
  'MESALVEINC',
  'OLLIES',
  'SHOE4500',
  'VARIETYWHO',
  'VERSONA',
  'ZUMIEZ'
];

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
}

function csvSet(value, fallback = []) {
  const parts = clean(value)
    .split(',')
    .map(item => item.trim().toUpperCase())
    .filter(Boolean);
  return new Set(parts.length ? parts : fallback);
}

export function certifiedCustomerSet() {
  return csvSet(
    process.env.A2000_STAGE1_CERTIFIED_CUSTOMERS,
    DEFAULT_CERTIFIED_CUSTOMERS
  );
}

export function isCertifiedCustomer(customerCode) {
  return certifiedCustomerSet().has(clean(customerCode).toUpperCase());
}

export function autoUploadEnabled() {
  return boolEnv(process.env.A2000_AUTO_UPLOAD_ENABLED, false);
}

function environmentName(baseUrl = process.env.A2000_BASE_URL) {
  const value = clean(baseUrl).toLowerCase();
  if (value.includes('amextest.a2000cloud.com') && value.includes('/ords/amxtest')) {
    return 'AMEXTEST';
  }
  return value ? 'PRODUCTION_OR_NON_TEST' : 'NOT_CONFIGURED';
}

export function launchStatus() {
  const headerUploadId = clean(process.env.A2000_ORDER_HD_UPLOAD_ID || 'ORDER_HD');
  const lineUploadId = clean(process.env.A2000_ORDER_LI_UPLOAD_ID || 'ORDER_LI');
  const sharedUploadIds = headerUploadId === 'ORDER_HD' || lineUploadId === 'ORDER_LI';

  return {
    environment: environmentName(),
    base_url: clean(process.env.A2000_BASE_URL),
    auto_upload_enabled: autoUploadEnabled(),
    certified_customers: [...certifiedCustomerSet()].sort(),
    header_upload_id: headerUploadId,
    line_upload_id: lineUploadId,
    shared_upload_ids: sharedUploadIds,
    production_write_gate_enabled: (
      clean(process.env.A2000_ALLOW_PRODUCTION_WRITES).toUpperCase()
      === 'I_UNDERSTAND_PRODUCTION_A2000_WRITES'
    ),
    safe_auto_upload_mode: autoUploadEnabled() && !sharedUploadIds,
    manual_upload_mode: true,
    email_scan_auto_parse: true,
    note: sharedUploadIds
      ? 'ORDER_HD/ORDER_LI are shared Upload IDs. Manual A2000 submit requires an explicit per-action ORDER_LI clear confirmation. Automatic A2000 upload should remain disabled until dedicated Upload IDs are configured.'
      : 'Dedicated A2000 Upload IDs are configured. Automatic upload may be enabled only for certified customers.'
  };
}

export function readingReadiness(order = {}) {
  const missing = [];
  const headerRequired = [
    ['customer_code', order.customer_code],
    ['order_no', order.order_no]
  ];
  for (const [field, value] of headerRequired) if (!clean(value)) missing.push(field);
  const lines = Array.isArray(order.purchase_order_lines) ? order.purchase_order_lines : [];
  if (!lines.length) missing.push('lines');
  for (const line of lines) {
    if (!clean(line.style_code)) missing.push(`line_${line.line_no}_style_code`);
    if (!clean(line.color_code)) missing.push(`line_${line.line_no}_color_code`);
    const qty = Number(line.qty_total || 0);
    if (!Number.isFinite(qty) || qty <= 0) missing.push(`line_${line.line_no}_qty_total`);
  }
  const blockingConflicts = (order.conflicts || []).filter(item => item?.blocking !== false && String(item?.severity || '').toLowerCase() !== 'low');
  return {
    valid: missing.length === 0 && blockingConflicts.length === 0,
    missing: [...new Set(missing)],
    blocking_conflicts: blockingConflicts
  };
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

async function orderById(orderId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('id', orderId)
    .single();

  if (error) throw error;
  return data;
}

function summarizePreflight(preflight = {}) {
  const errors = [];

  for (const item of preflight.validation?.errors || []) {
    errors.push({
      source: 'local',
      code: item.code || item.field || 'LOCAL_VALIDATION',
      field: item.field || null,
      line_no: item.line_no || null,
      message: item.message || null
    });
  }

  for (const item of preflight.source_guard?.errors || []) {
    errors.push({
      source: 'source_guard',
      code: item.code || 'SOURCE_GUARD',
      field: null,
      line_no: null,
      message: item.message || null
    });
  }

  for (const line of preflight.live_scale_validation?.lines || []) {
    for (const item of line.errors || []) {
      errors.push({
        source: 'live_scale',
        code: item.code || 'LIVE_SCALE',
        field: null,
        line_no: line.line_no || null,
        message: item.message || null
      });
    }
  }

  return {
    valid: preflight.valid === true,
    idempotency_key: preflight.idempotency_key || null,
    local_valid: preflight.validation?.valid === true,
    source_guard_valid: preflight.source_guard?.valid === true,
    live_scale_valid: preflight.live_scale_validation?.valid === true,
    errors
  };
}


function runtimeErrorSummary(error) {
  return classifyA2000RuntimeError(error);
}

async function recordPreflightException(order, error) {
  try {
    const identity = buildIdempotencyKey(order);
    const loaded = await createOrLoadA2000Job({
      idempotencyKey: identity,
      sourcePayloadHash: identity,
      order
    });

    if (loaded.job?.status === 'completed') {
      return loaded.job;
    }

    return await updateA2000Job(
      loaded.job.id,
      {
        status: 'failed_preflight',
        attempt_count: Number(loaded.job.attempt_count || 0) + 1,
        last_error: runtimeErrorSummary(error)
      }
    );
  } catch {
    // Never replace the original preflight failure with logging/storage failure.
    return null;
  }
}

function runtimePreflightSummary(error) {
  const detail = runtimeErrorSummary(error);

  return {
    valid: false,
    idempotency_key: null,
    local_valid: false,
    source_guard_valid: false,
    live_scale_valid: false,
    service_available: !detail.transient,
    write_performed: false,
    errors: [{
      source: detail.stage,
      code: detail.code,
      field: null,
      line_no: null,
      message: detail.message,
      raw_message: detail.raw_message,
      http_status: detail.http_status,
      transient: detail.transient
    }]
  };
}

function summarizeUpload(result = null) {
  if (!result) return null;

  return {
    ok: result.ok === true,
    stage: result.stage || null,
    idempotent: result.idempotent === true,
    job_status: result.job?.status || null,
    a2000_seq_order_no: result.job?.a2000_seq_order_no
      || result.a2000?.seq_order_no
      || null,
    a2000_ctrl_no: result.job?.a2000_ctrl_no
      || result.a2000?.ctrl_no
      || null,
    last_error: result.job?.last_error || null
  };
}

async function withOrderLiClearConfirmation(confirmOrderLiCleared, callback) {
  const previous = process.env.A2000_ORDER_LI_CLEARED;

  try {
    if (confirmOrderLiCleared) {
      process.env.A2000_ORDER_LI_CLEARED = 'YES';
    } else {
      delete process.env.A2000_ORDER_LI_CLEARED;
    }

    return await callback();
  } finally {
    if (previous === undefined) delete process.env.A2000_ORDER_LI_CLEARED;
    else process.env.A2000_ORDER_LI_CLEARED = previous;
  }
}

export async function uploadOrderWorkflow(
  orderId,
  {
    confirmOrderLiCleared = false
  } = {}
) {
  const order = await orderById(orderId);
  const certified = isCertifiedCustomer(order.customer_code);
  const adapter = new A2000RestAdapter();

  let preflight;
  let preflightSummary;

  try {
    preflight = await adapter.preflight(order);
    preflightSummary = summarizePreflight(preflight);
  } catch (error) {
    const job = await recordPreflightException(order, error);

    return {
      ok: false,
      stage: 'failed_preflight',
      customer_code: order.customer_code,
      order_no: order.order_no,
      certified,
      preflight: runtimePreflightSummary(error),
      upload: {
        ok: false,
        stage: 'failed_preflight',
        idempotent: false,
        job_status: job?.status || 'failed_preflight',
        a2000_seq_order_no: job?.a2000_seq_order_no || null,
        a2000_ctrl_no: job?.a2000_ctrl_no || null,
        last_error: job?.last_error || runtimeErrorSummary(error)
      }
    };
  }

  if (!certified) {
    return {
      ok: false,
      stage: 'customer_not_stage1_certified',
      customer_code: order.customer_code,
      order_no: order.order_no,
      certified: false,
      preflight: preflightSummary,
      upload: null
    };
  }

  if (!preflight.valid) {
    return {
      ok: false,
      stage: 'failed_preflight',
      customer_code: order.customer_code,
      order_no: order.order_no,
      certified: true,
      preflight: preflightSummary,
      upload: null
    };
  }

  const upload = await withOrderLiClearConfirmation(
    confirmOrderLiCleared,
    async () => adapter.uploadOrder(order, { confirmWrite: true })
  );

  return {
    ok: upload.ok === true,
    stage: upload.stage || null,
    customer_code: order.customer_code,
    order_no: order.order_no,
    certified: true,
    preflight: preflightSummary,
    upload: summarizeUpload(upload)
  };
}

export async function processDocumentWorkflow(
  documentId,
  {
    uploadToA2000 = false,
    confirmOrderLiCleared = false
  } = {}
) {
  const processing = await processDownloadedDocuments({
    limit: 1,
    documentId
  });

  const orders = await ordersByDocument(documentId);
  const checklistResults = [];

  for (const order of orders) {
    try {
      checklistResults.push(await generateChecklistForOrder(order.id));
    } catch (error) {
      checklistResults.push({
        ok: false,
        purchase_order_id: order.id,
        error: error.message
      });
    }
  }

  // Reading/reprocessing is intentionally isolated from live A2000.
  // No OAuth call, no preflight job and no A2000 LOG row is created here.
  if (!uploadToA2000) {
    return {
      ok: orders.every(order => ['parsed', 'needs_mapping'].includes(order.status)),
      document_id: documentId,
      processing,
      upload_requested: false,
      live_preflight_requested: false,
      write_halted: false,
      a2000_write_performed: false,
      orders: orders.map(order => ({
        purchase_order_id: order.id,
        document_id: order.document_id,
        customer_code: order.customer_code,
        order_no: order.order_no,
        status: order.status,
        source_file_name: order.source_file_name,
        line_count: order.purchase_order_lines?.length || 0,
        certified: isCertifiedCustomer(order.customer_code),
        preflight: null,
        upload: null,
        skipped_reason: 'LIVE_A2000_NOT_REQUESTED'
      })),
      checklists: checklistResults
    };
  }

  const orderResults = [];
  let haltWrites = false;

  for (const order of orders) {
    if (haltWrites) {
      orderResults.push({
        ok: false,
        purchase_order_id: order.id,
        document_id: order.document_id,
        customer_code: order.customer_code,
        order_no: order.order_no,
        stage: 'skipped_after_prior_write_failure',
        a2000_write_performed: false
      });
      continue;
    }

    const result = await uploadOrderWorkflow(order.id, {
      confirmOrderLiCleared
    });

    orderResults.push({
      purchase_order_id: order.id,
      document_id: order.document_id,
      ...result
    });

    if (
      !result.ok
      && ![
        'failed_preflight',
        'a2000_service_unavailable',
        'customer_not_stage1_certified'
      ].includes(result.stage)
    ) {
      haltWrites = true;
    }
  }

  return {
    ok: orderResults.every(item => item.ok),
    document_id: documentId,
    processing,
    upload_requested: true,
    live_preflight_requested: true,
    write_halted: haltWrites,
    a2000_write_performed: orderResults.some(
      item => item.upload?.a2000_seq_order_no || item.upload?.a2000_ctrl_no
    ),
    orders: orderResults,
    checklists: checklistResults
  };
}

export async function processScannedDocuments(
  documents = [],
  {
    uploadToA2000 = autoUploadEnabled()
  } = {}
) {
  const results = [];

  for (const document of documents) {
    try {
      results.push(
        await processDocumentWorkflow(document.id, {
          uploadToA2000,
          // Automatic jobs never spoof a shared ORDER_LI clear confirmation.
          confirmOrderLiCleared: false
        })
      );
    } catch (error) {
      results.push({
        ok: false,
        document_id: document.id,
        error: error?.message || String(error)
      });
    }
  }

  return {
    processed_document_count: results.length,
    auto_upload_requested: uploadToA2000,
    results
  };
}

export async function processPendingDocuments({
  limit = 50,
  uploadToA2000 = false,
  confirmOrderLiCleared = false
} = {}) {
  const { data: documents, error } = await supabase
    .from('documents')
    .select('id, file_name, status')
    .in('status', ['downloaded', 'parse_error', 'parsed', 'needs_mapping'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const results = [];
  let haltWrites = false;

  for (const document of documents || []) {
    if (haltWrites && uploadToA2000) {
      results.push({
        ok: false,
        document_id: document.id,
        skipped_reason: 'HALTED_AFTER_PRIOR_A2000_WRITE_FAILURE'
      });
      continue;
    }

    const result = await processDocumentWorkflow(document.id, {
      uploadToA2000,
      confirmOrderLiCleared
    });
    results.push(result);

    if (result.write_halted) haltWrites = true;
  }

  return {
    ok: !haltWrites,
    processed_document_count: results.length,
    upload_requested: uploadToA2000,
    write_halted: haltWrites,
    results
  };
}

async function attachDocuments(orders = []) {
  const documentIds = [
    ...new Set(
      orders.map(order => clean(order.document_id)).filter(Boolean)
    )
  ];

  if (!documentIds.length) return new Map();

  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .in('id', documentIds);

  if (error) throw error;
  return new Map((data || []).map(document => [String(document.id), document]));
}

async function attachJobs(orders = []) {
  const orderIds = orders.map(order => String(order.id)).filter(Boolean);
  if (!orderIds.length) return new Map();

  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('*')
    .in('purchase_order_id', orderIds)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  const byOrder = new Map();

  for (const job of data || []) {
    const key = String(job.purchase_order_id || '');
    if (key && !byOrder.has(key)) byOrder.set(key, job);
  }

  return byOrder;
}

function operationalHaystack(item) {
  return [
    item.order_no,
    item.customer_code,
    item.status,
    item.source_file_name,
    item.document?.file_name,
    item.document?.subject,
    item.a2000_job?.status,
    item.a2000_job?.a2000_ctrl_no,
    ...(item.purchase_order_lines || []).flatMap(line => [
      line.style_code,
      line.style_raw,
      line.color_code,
      line.color_raw,
      line.customer_sku,
      line.ticket_sku,
      JSON.stringify(line.raw_json || {})
    ])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export async function listOperationalOrders({
  limit = 500,
  q = '',
  customer = '',
  status = ''
} = {}) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const orders = data || [];
  const [documents, jobs] = await Promise.all([
    attachDocuments(orders),
    attachJobs(orders)
  ]);

  const query = clean(q).toLowerCase();
  const customerFilter = clean(customer).toUpperCase();
  const statusFilter = clean(status).toLowerCase();

  const hydrated = orders
    .map(order => {
      const document = documents.get(String(order.document_id)) || null;
      const a2000Job = jobs.get(String(order.id)) || null;

      const reading = readingReadiness(order);
      const localValidation = validateInternalOrder(order);
      return {
        ...order,
        document,
        a2000_job: a2000Job,
        stage1_certified: isCertifiedCustomer(order.customer_code),
        reading_valid: reading.valid,
        reading_missing: reading.missing,
        reading_blocking_conflicts: reading.blocking_conflicts,
        a2000_local_ready: localValidation.valid,
        a2000_local_errors: localValidation.errors,
        a2000_local_warnings: localValidation.warnings
      };
    });

  // The list is newest-first. Keep the newest operational representation for
  // the same PDF bytes + customer + PO so old duplicate scan rows do not flood UI.
  const seenOperationalKeys = new Set();
  const deduped = hydrated.filter(item => {
    const sha = clean(item.document?.sha256);
    const documentIdentity = sha || clean(item.document_id);
    const key = [
      documentIdentity,
      clean(item.customer_code).toUpperCase(),
      clean(item.order_no).toUpperCase()
    ].join('|');

    if (seenOperationalKeys.has(key)) return false;
    seenOperationalKeys.add(key);
    return true;
  });

  return deduped
    .filter(item => (
      !customerFilter
      || clean(item.customer_code).toUpperCase() === customerFilter
    ))
    .filter(item => (
      !statusFilter
      || clean(item.status).toLowerCase() === statusFilter
      || clean(item.a2000_job?.status).toLowerCase() === statusFilter
    ))
    .filter(item => !query || operationalHaystack(item).includes(query));
}

function firstArrayPayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return [];

  for (const value of Object.values(payload)) {
    if (Array.isArray(value)) return value;
  }

  return [];
}

function positiveQtyBuckets(row = {}) {
  const buckets = {};

  for (let index = 1; index <= 18; index += 1) {
    const key = `QTY_SZ${index}`;
    const value = Number(row[key] || 0);

    if (Number.isFinite(value) && value > 0) {
      buckets[key] = value;
    }
  }

  return buckets;
}

function uploadedLineSummary(row = {}, fallbackLineNo = 1) {
  const qtyBuckets = positiveQtyBuckets(row);
  const qtyTotal = Object.values(qtyBuckets)
    .reduce((sum, value) => sum + Number(value || 0), 0);

  return {
    line_no: row.LINE_NO ?? fallbackLineNo,
    style: row.STYLE || null,
    color_no: row.COLOR_NO || null,
    sales_price: row.SALES_PRICE ?? null,
    warehouse: row.WHOUSE || null,
    customer: row.CUST_NO || null,
    store_no: row.STORE_NO || null,
    order_no: row.ORDER_NO || null,
    seq_order_no: row.SEQ_ORDER_NO ?? null,
    qty_total: qtyTotal,
    qty_buckets: qtyBuckets
  };
}

function uploadResponseSummary(body = null) {
  if (!body || typeof body !== 'object') return null;

  return {
    status: body.status || null,
    updated: body.updated ?? null,
    message: body.message || null,
    errors: Array.isArray(body.errors) ? body.errors : []
  };
}

export async function listOperationsLog({
  limit = 500,
  q = ''
} = {}) {
  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  const query = clean(q).toLowerCase();

  return (data || [])
    .map(job => {
      const headerRows = firstArrayPayload(job.header_request || {});
      const lineRows = firstArrayPayload(job.lines_request || {});
      const uploadedHeader = headerRows[0] || null;
      const uploadedLines = lineRows.map(uploadedLineSummary);
      const uploadedTotalQty = uploadedLines
        .reduce((sum, line) => sum + Number(line.qty_total || 0), 0);

      return {
        id: job.id,
        created_at: job.created_at || null,
        updated_at: job.updated_at || null,
        completed_at: job.completed_at || null,
        customer_code: job.customer_code || uploadedHeader?.CUST_NO || null,
        store_code: job.store_code || uploadedHeader?.STORE_NO || null,
        order_no: job.order_no || uploadedHeader?.ORDER_NO || null,
        status: job.status || null,
        attempt_count: job.attempt_count || 0,
        document_id: job.document_id || null,
        purchase_order_id: job.purchase_order_id || null,
        a2000_seq_order_no: job.a2000_seq_order_no || null,
        a2000_ctrl_no: job.a2000_ctrl_no || null,
        uploaded_header: uploadedHeader,
        uploaded_lines: uploadedLines,
        uploaded_line_count: uploadedLines.length,
        uploaded_total_qty: uploadedTotalQty,
        header_result: uploadResponseSummary(job.header_response_json),
        lines_result: uploadResponseSummary(job.lines_response_json),
        header_request: job.header_request || null,
        lines_request: job.lines_request || null,
        header_response_json: job.header_response_json || null,
        lines_response_json: job.lines_response_json || null,
        last_error: job.last_error || null
      };
    })
    .filter(item => {
      if (!query) return true;

      return [
        item.customer_code,
        item.order_no,
        item.status,
        item.a2000_ctrl_no,
        item.a2000_seq_order_no,
        ...item.uploaded_lines.flatMap(line => [
          line.style,
          line.color_no,
          line.qty_total,
          JSON.stringify(line.qty_buckets || {})
        ]),
        JSON.stringify(item.last_error || {})
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
}


let bulkUploadLock = false;

export async function uploadAllValidatedOrders({
  limit = 50,
  confirmOrderLiCleared = false
} = {}) {
  if (bulkUploadLock) {
    return { ok: false, stage: 'bulk_upload_already_running', results: [] };
  }

  bulkUploadLock = true;
  try {
    const orders = await listOperationalOrders({ limit: Math.max(limit * 4, 200) });
    const candidates = orders
      .filter(order => order.stage1_certified)
      .filter(order => order.reading_valid)
      .filter(order => order.a2000_local_ready)
      .filter(order => order.a2000_job?.status !== 'completed')
      .slice(0, limit);

    const results = [];
    let halted = false;

    for (const order of candidates) {
      if (halted) {
        results.push({
          ok: false,
          purchase_order_id: order.id,
          customer_code: order.customer_code,
          order_no: order.order_no,
          stage: 'skipped_after_uncertain_write_failure'
        });
        continue;
      }

      const result = await uploadOrderWorkflow(order.id, { confirmOrderLiCleared });
      results.push({
        purchase_order_id: order.id,
        customer_code: order.customer_code,
        order_no: order.order_no,
        ...result
      });

      if (!result.ok && !['failed_preflight', 'customer_not_stage1_certified'].includes(result.stage)) {
        halted = true;
      }
    }

    return {
      ok: !halted,
      stage: halted ? 'bulk_halted_after_write_failure' : 'bulk_completed',
      candidate_count: candidates.length,
      completed_count: results.filter(item => item.ok).length,
      failed_count: results.filter(item => !item.ok && !String(item.stage).startsWith('skipped')).length,
      skipped_count: results.filter(item => String(item.stage).startsWith('skipped')).length,
      halted,
      results
    };
  } finally {
    bulkUploadLock = false;
  }
}


// A2000_V4_7_1_SAFE_PREFLIGHT_API
export async function preflightOrderWorkflow(orderId) {
  const order = await orderById(orderId);
  const certified = isCertifiedCustomer(order.customer_code);
  const adapter = new A2000RestAdapter();

  try {
    const preflight = await adapter.preflight(order);
    const summary = summarizePreflight(preflight);

    return {
      ok: summary.valid && certified,
      stage: !certified
        ? 'customer_not_stage1_certified'
        : summary.valid
          ? 'preflight_passed'
          : 'failed_preflight',
      purchase_order_id: order.id,
      document_id: order.document_id || null,
      customer_code: order.customer_code,
      order_no: order.order_no,
      certified,
      service_available: true,
      preflight: summary,
      a2000_write_performed: false
    };
  } catch (error) {
    const summary = runtimePreflightSummary(error);
    const serviceUnavailable = summary.errors.some(
      item => item.code === 'A2000_SERVICE_UNAVAILABLE'
    );

    return {
      ok: false,
      stage: serviceUnavailable
        ? 'a2000_service_unavailable'
        : 'preflight_exception',
      purchase_order_id: order.id,
      document_id: order.document_id || null,
      customer_code: order.customer_code,
      order_no: order.order_no,
      certified,
      service_available: !serviceUnavailable,
      preflight: summary,
      a2000_write_performed: false
    };
  }
}

export async function preflightOperationalOrders({ limit = 20 } = {}) {
  const orders = await listOperationalOrders({ limit: Math.max(limit * 3, 100) });
  const candidates = orders
    .filter(order => order.stage1_certified)
    .filter(order => order.reading_valid)
    .filter(order => order.a2000_local_ready)
    .filter(order => order.a2000_job?.status !== 'completed')
    .slice(0, limit);

  const results = [];
  for (const order of candidates) {
    results.push(await preflightOrderWorkflow(order.id));
  }

  return {
    ok: true,
    candidate_count: candidates.length,
    passed_count: results.filter(item => item.ok).length,
    failed_count: results.filter(item => !item.ok).length,
    a2000_write_performed: false,
    results
  };
}
