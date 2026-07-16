import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { supabase } from '../../supabase.js';
import { A2000RestClient } from '../restClient.js';
import {
  buildAuthoritativeChecklistInput
} from './pickTicketCore.js';
import {
  correlatePickTicketOrder,
  groupPickTicketViewerRows,
  orderNumberCandidates,
  snapshotFingerprint
} from './pickTicketSnapshotCore.js';
import {
  generateChecklistForPickTicketDocument
} from './controlChecklistService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const CHECKLIST_INPUT_DIR = path.join(
  API_ROOT,
  'storage',
  'checklist-inputs'
);

const VIEWER_COLUMNS = [
  'PICKTKT',
  'CTRL_NO',
  'ORDER_NO',
  'PO',
  'CUSTOMER',
  'CUST_NAME',
  'STORE',
  'WH',
  'STATUS',
  'PT_TRACK',
  'LINE_NO',
  'STYLE',
  'CLR',
  'SKU',
  'SCALE',
  'CUST_STYLE1',
  'CUST_STYLE2',
  'PICK_QTY',
  'ORDER_QTY',
  'SHIP_QTY',
  'PRICE',
  'EXTENSION',
  'ENTRY_DATE',
  'MODIFY_DATE',
  'LINE_ENTRY_DATE',
  'LINE_MODIFY_DATE'
];

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function boolEnv(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['true', '1', 'yes', 'y'].includes(
    String(value).toLowerCase()
  );
}

function normalizePart(value = '') {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'unknown';
}

function escapeLiteral(value) {
  return clean(value).replaceAll("'", "''");
}

function sqlStringList(values = []) {
  return values
    .map(value => `'${escapeLiteral(value)}'`)
    .join(',');
}

function uniqueBy(values = [], keyFn) {
  const seen = new Set();
  const output = [];

  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }

  return output;
}

async function ensureBucket() {
  const bucket = clean(
    process.env.PICK_TICKET_STORAGE_BUCKET
    || 'pick-tickets'
  );
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  if (!(data || []).some(item => item.name === bucket)) {
    const { error: createError } = await supabase.storage.createBucket(
      bucket,
      {
        public: false,
        fileSizeLimit: 50 * 1024 * 1024
      }
    );

    if (
      createError
      && !/already exists|duplicate/i.test(createError.message || '')
    ) {
      throw createError;
    }
  }

  return bucket;
}

async function recentOrders({ limit = 200, orderId = null } = {}) {
  let query = supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (orderId) query = query.eq('id', orderId);

  const { data, error } = await query;
  if (error) throw error;

  // Outlook rescans may create several operational aliases for the same PDF.
  // Keep the newest materially identical PO/store/line representation so a
  // Pick Ticket does not become ambiguous merely because the same hardcopy
  // was received or scanned more than once.
  const seen = new Set();
  return (data || []).filter(order => {
    const lineSignature = (order.purchase_order_lines || [])
      .map(line => [
        clean(line.style_code),
        clean(line.color_code),
        Number(line.qty_total || 0)
      ].join(':'))
      .sort()
      .join(',');
    const key = [
      clean(order.customer_code).toUpperCase(),
      orderNumberCandidates(order.order_no)[1]
        || clean(order.order_no),
      clean(order.store_code || order.store_raw).toUpperCase(),
      lineSignature
    ].join('|');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function jobsByControl(orders = []) {
  const orderIds = orders.map(order => String(order.id)).filter(Boolean);
  if (!orderIds.length) return new Map();

  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('purchase_order_id,a2000_ctrl_no,a2000_seq_order_no,status,updated_at')
    .in('purchase_order_id', orderIds)
    .order('updated_at', { ascending: false });

  if (error) {
    // Snapshot matching still works through PO/store/style evidence.
    return new Map();
  }

  const output = new Map();

  for (const job of data || []) {
    const control = clean(
      job.a2000_ctrl_no
      || job.a2000_seq_order_no
    );
    if (control && !output.has(control)) {
      output.set(control, String(job.purchase_order_id));
    }
  }

  return output;
}

function groupOrdersForLookup(orders = []) {
  const grouped = new Map();

  for (const order of orders) {
    const customer = clean(order.customer_code).toUpperCase();
    const orderNo = clean(order.order_no);
    if (!customer || !orderNo) continue;

    const key = `${customer}|${orderNo}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        customer_code: customer,
        order_no: orderNo,
        orders: []
      });
    }
    grouped.get(key).orders.push(order);
  }

  return [...grouped.values()];
}

async function queryPickTicketRows(client, lookup) {
  const candidates = orderNumberCandidates(lookup.order_no);
  if (!candidates.length) return [];

  const customerFilter = (
    `CUSTOMER = '${escapeLiteral(lookup.customer_code)}'`
  );
  const candidateFilter = sqlStringList(candidates);
  const filters = [
    `${customerFilter} AND ORDER_NO IN (${candidateFilter}) AND PICKTKT > 0`,
    `${customerFilter} AND PO IN (${candidateFilter}) AND PICKTKT > 0`
  ];
  const allRows = [];

  for (const filter of filters) {
    const result = await client.viewer('VR_ORDER_LI', {
      columns: VIEWER_COLUMNS,
      filter,
      sort: 'PICKTKT,CTRL_NO,LINE_NO'
    });

    if (result.httpStatus !== 200) {
      throw new Error(
        `VR_ORDER_LI HTTP ${result.httpStatus} for ${lookup.customer_code} PO ${lookup.order_no}`
      );
    }

    allRows.push(...result.rows);
  }

  return uniqueBy(
    allRows,
    row => [
      row.PICKTKT,
      row.CTRL_NO,
      row.LINE_NO,
      row.STYLE,
      row.CLR
    ].join('|')
  );
}

async function writeChecklistInput(input) {
  await fs.mkdir(CHECKLIST_INPUT_DIR, { recursive: true });
  const filePath = path.join(
    CHECKLIST_INPUT_DIR,
    [
      normalizePart(input.customer_code),
      normalizePart(input.order_no),
      normalizePart(input.control_no),
      `PT-${normalizePart(input.pick_ticket_no)}.json`
    ].join('_')
  );

  await fs.writeFile(
    filePath,
    JSON.stringify(input, null, 2),
    'utf8'
  );

  return {
    ...input,
    file_path: filePath
  };
}

async function existingDocument(externalKey) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('external_key', externalKey)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : null;
}

async function persistSnapshot({
  snapshot,
  order,
  checklistInput,
  match
}) {
  const bucket = await ensureBucket();
  const externalKey = [
    'a2000-pick-ticket',
    snapshot.control_no,
    snapshot.pick_ticket_no
  ].join('|');
  const current = await existingDocument(externalKey);
  const fingerprint = snapshotFingerprint(snapshot);

  if (
    current
    && clean(current.raw?.snapshot_fingerprint) === fingerprint
    && clean(current.raw?.purchase_order_id)
      === clean(order?.id)
  ) {
    return {
      document: current,
      changed: false,
      stage: order
        ? 'pick_ticket_snapshot_unchanged_matched'
        : 'pick_ticket_snapshot_unchanged_unmatched'
    };
  }

  const jsonText = JSON.stringify(snapshot, null, 2);
  const buffer = Buffer.from(jsonText, 'utf8');
  const sha256 = crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');
  const storagePath = [
    normalizePart(snapshot.customer_code || order?.customer_code),
    normalizePart(snapshot.order_no || order?.order_no),
    normalizePart(snapshot.control_no),
    `PT-${normalizePart(snapshot.pick_ticket_no)}-snapshot.json`
  ].join('/');

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: 'application/json',
      upsert: true
    });
  if (uploadError) throw uploadError;

  const currentRaw = current?.raw && typeof current.raw === 'object'
    ? current.raw
    : {};
  const mergedRaw = {
    ...currentRaw,
    document_type: currentRaw.pdf_available
      ? 'pick_ticket_pdf'
      : 'pick_ticket_snapshot',
    authoritative_source: 'pick_ticket',
    pick_ticket_no: snapshot.pick_ticket_no,
    control_no: snapshot.control_no,
    order_no: snapshot.order_no || order?.order_no || null,
    a2000_order_no: snapshot.a2000_order_no || null,
    store_code: snapshot.store_code || order?.store_code || null,
    customer_code: snapshot.customer_code || order?.customer_code || null,
    purchase_order_id: order?.id || currentRaw.purchase_order_id || null,
    control_identity: checklistInput?.control_identity
      || snapshot.control_identity,
    source_precedence: (
      'PICK_TICKET_PDF_THEN_SNAPSHOT_THEN_HARDCOPY'
    ),
    pick_ticket_snapshot: snapshot,
    snapshot_storage_bucket: bucket,
    snapshot_storage_path: storagePath,
    snapshot_sha256: sha256,
    snapshot_fingerprint: fingerprint,
    snapshot_captured_at: snapshot.captured_at,
    checklist_input_path: checklistInput?.file_path
      || currentRaw.checklist_input_path
      || null,
    checklist_conflict_count: checklistInput?.conflict_count
      ?? currentRaw.checklist_conflict_count
      ?? 0,
    checklist_status: order
      ? currentRaw.checklist_status === 'generated'
        ? 'generated'
        : 'authoritative_input_ready'
      : 'waiting_for_exact_order_match',
    match_reason: match?.reason || null,
    match_score: match?.score || 0,
    match_candidates: (match?.candidates || []).map(candidate => ({
      purchase_order_id: candidate.order?.id || null,
      order_no: candidate.order?.order_no || null,
      store_code: candidate.order?.store_code || null,
      score: candidate.score,
      reasons: candidate.reasons
    })),
    pdf_available: currentRaw.pdf_available === true,
    persisted_at: new Date().toISOString()
  };

  const row = current?.raw?.pdf_available === true
    ? {
        status: order
          ? 'pick_ticket_ready'
          : 'pick_ticket_unmatched',
        detected_customer: mergedRaw.customer_code,
        detected_po: mergedRaw.order_no,
        raw: mergedRaw
      }
    : {
        external_key: externalKey,
        source: 'a2000_pick_ticket_snapshot',
        email_external_key: null,
        subject: (
          `Pick Ticket ${snapshot.pick_ticket_no} `
          + `Control ${snapshot.control_no} · data snapshot`
        ),
        sender_name: 'A2000 VR_ORDER_LI observer',
        sender_email: null,
        file_name: `PT-${snapshot.pick_ticket_no}-CTRL-${snapshot.control_no}.json`,
        storage_bucket: bucket,
        storage_path: storagePath,
        file_size: buffer.length,
        sha256,
        status: order
          ? 'pick_ticket_data_ready'
          : 'pick_ticket_data_unmatched',
        detected_customer: mergedRaw.customer_code,
        detected_po: mergedRaw.order_no,
        ocr_text: null,
        raw: mergedRaw
      };

  let data;
  let error;

  if (current) {
    ({ data, error } = await supabase
      .from('documents')
      .update(row)
      .eq('id', current.id)
      .select('*')
      .single());
  } else {
    ({ data, error } = await supabase
      .from('documents')
      .upsert(row, { onConflict: 'external_key' })
      .select('*')
      .single());
  }

  if (error) throw error;

  return {
    document: data,
    changed: true,
    stage: order
      ? 'pick_ticket_snapshot_persisted_and_matched'
      : 'pick_ticket_snapshot_persisted_unmatched'
  };
}

async function maybeGenerateChecklist(document, order) {
  if (!order) return null;
  if (!boolEnv(process.env.PICK_TICKET_AUTO_CHECKLIST_ENABLED, true)) {
    return null;
  }

  try {
    return await generateChecklistForPickTicketDocument(document.id);
  } catch (error) {
    return {
      ok: false,
      generated: false,
      reason: 'PICK_TICKET_CHECKLIST_GENERATION_ERROR',
      error: error.message
    };
  }
}

export async function reconcilePickTicketSnapshots({
  limit = Number(
    process.env.A2000_PICK_TICKET_SNAPSHOT_ORDER_LIMIT || 200
  ),
  orderId = null,
  client = new A2000RestClient()
} = {}) {
  const orders = await recentOrders({ limit, orderId });
  const jobs = await jobsByControl(orders);
  const lookups = groupOrdersForLookup(orders);
  const results = [];
  let excludedParentCount = 0;

  for (const lookup of lookups) {
    try {
      const rows = await queryPickTicketRows(client, lookup);
      const grouped = groupPickTicketViewerRows(rows);
      excludedParentCount += grouped.excluded_parent_count;

      for (const snapshot of grouped.groups) {
        const controlPurchaseOrderId = jobs.get(
          clean(snapshot.control_no)
        ) || null;
        const match = correlatePickTicketOrder(
          lookup.orders,
          snapshot,
          { controlPurchaseOrderId }
        );
        const order = match.order;
        const checklistInput = order
          ? await writeChecklistInput(
              buildAuthoritativeChecklistInput({
                order,
                identity: {
                  customer_code: snapshot.customer_code
                    || order.customer_code,
                  order_no: snapshot.order_no
                    || order.order_no,
                  a2000_order_no: snapshot.a2000_order_no,
                  control_no: snapshot.control_no,
                  pick_ticket_no: snapshot.pick_ticket_no,
                  store_code: snapshot.store_code
                    || order.store_code,
                  warehouse_code: snapshot.warehouse_code
                    || order.warehouse_code
                },
                pickTicketLines: snapshot.lines,
                pickTicketSource: 'pick_ticket_snapshot'
              })
            )
          : null;
        const persisted = await persistSnapshot({
          snapshot,
          order,
          checklistInput,
          match
        });
        const checklist = persisted.changed
          ? await maybeGenerateChecklist(
              persisted.document,
              order
            )
          : null;

        results.push({
          ok: true,
          stage: persisted.stage,
          changed: persisted.changed,
          document_id: persisted.document.id,
          purchase_order_id: order?.id || null,
          match_reason: match.reason,
          match_score: match.score,
          identity: {
            customer_code: snapshot.customer_code,
            order_no: snapshot.order_no,
            a2000_order_no: snapshot.a2000_order_no,
            control_no: snapshot.control_no,
            pick_ticket_no: snapshot.pick_ticket_no,
            store_code: snapshot.store_code
          },
          line_count: snapshot.lines.length,
          picked_quantity: snapshot.picked_quantity,
          checklist_input_path: checklistInput?.file_path || null,
          checklist,
          pdf_required_for_data: false
        });
      }
    } catch (error) {
      results.push({
        ok: false,
        stage: 'pick_ticket_snapshot_error',
        customer_code: lookup.customer_code,
        order_no: lookup.order_no,
        error: error.message
      });
    }
  }

  return {
    ok: results.every(item => item.ok),
    observed_order_group_count: lookups.length,
    snapshot_count: results.filter(item => item.ok).length,
    changed_count: results.filter(
      item => item.ok && item.changed
    ).length,
    unchanged_count: results.filter(
      item => item.ok && !item.changed
    ).length,
    matched_count: results.filter(
      item => item.purchase_order_id
    ).length,
    unmatched_count: results.filter(
      item => item.ok && !item.purchase_order_id
    ).length,
    generated_checklist_count: results.filter(
      item => item.checklist?.ok
    ).length,
    excluded_parent_count: excludedParentCount,
    pdf_required_for_data: false,
    results
  };
}

export async function listPickTicketSnapshots({ limit = 500 } = {}) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .in('source', [
      'a2000_pick_ticket_snapshot',
      'a2000_pick_ticket_observer'
    ])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return (data || []).map(item => ({
    ...item,
    pick_ticket_no: item.raw?.pick_ticket_no || null,
    control_no: item.raw?.control_no || null,
    order_no: item.raw?.order_no || item.detected_po || null,
    a2000_order_no: item.raw?.a2000_order_no || null,
    store_code: item.raw?.store_code || null,
    customer_code: item.raw?.customer_code
      || item.detected_customer
      || null,
    purchase_order_id: item.raw?.purchase_order_id || null,
    checklist_status: item.raw?.checklist_status || null,
    checklist_input_path: item.raw?.checklist_input_path || null,
    checklist_conflict_count: item.raw?.checklist_conflict_count || 0,
    checklist_available: Boolean(
      item.raw?.generated_checklist_path
    ),
    checklist_file_name: item.raw?.generated_checklist_file_name || null,
    pdf_available: item.raw?.pdf_available === true,
    snapshot_available: Boolean(item.raw?.pick_ticket_snapshot),
    snapshot_line_count: item.raw?.pick_ticket_snapshot?.lines?.length || 0,
    picked_quantity: item.raw?.pick_ticket_snapshot?.picked_quantity || 0,
    match_reason: item.raw?.match_reason || null,
    match_score: item.raw?.match_score || 0
  }));
}

let watcherTimer = null;
let watcherRunning = false;
let watcherState = {
  started: false,
  running: false,
  last_started_at: null,
  last_completed_at: null,
  last_error: null,
  last_result: null
};

export function pickTicketSnapshotWatcherStatus() {
  return { ...watcherState };
}

export function startPickTicketSnapshotWatcher() {
  if (watcherTimer) return watcherTimer;
  if (!boolEnv(process.env.A2000_PICK_TICKET_SNAPSHOT_ENABLED, true)) {
    watcherState = {
      ...watcherState,
      started: false,
      last_error: 'DISABLED_BY_ENV'
    };
    return null;
  }

  const pollMs = Math.max(
    5000,
    Number(
      process.env.A2000_PICK_TICKET_SNAPSHOT_POLL_MS || 10000
    )
  );

  const run = async () => {
    if (watcherRunning) return;
    watcherRunning = true;
    watcherState = {
      ...watcherState,
      started: true,
      running: true,
      last_started_at: new Date().toISOString(),
      last_error: null
    };

    try {
      const result = await reconcilePickTicketSnapshots();
      watcherState = {
        ...watcherState,
        running: false,
        last_completed_at: new Date().toISOString(),
        last_result: {
          snapshot_count: result.snapshot_count,
          changed_count: result.changed_count,
          matched_count: result.matched_count,
          unmatched_count: result.unmatched_count,
          generated_checklist_count: result.generated_checklist_count
        }
      };

      if (
        result.changed_count
        || result.generated_checklist_count
      ) {
        console.log(
          `[pick-ticket-snapshot] snapshots=${result.snapshot_count} `
          + `changed=${result.changed_count} `
          + `matched=${result.matched_count} `
          + `unmatched=${result.unmatched_count} `
          + `checklists=${result.generated_checklist_count}`
        );
      }
    } catch (error) {
      watcherState = {
        ...watcherState,
        running: false,
        last_completed_at: new Date().toISOString(),
        last_error: error.message
      };
      console.error(
        '[pick-ticket-snapshot] error:',
        error.message
      );
    } finally {
      watcherRunning = false;
    }
  };

  run();
  watcherTimer = setInterval(run, pollMs);
  watcherTimer.unref?.();
  return watcherTimer;
}
