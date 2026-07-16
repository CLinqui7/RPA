import path from 'node:path';
import {
  buildPickTicketGroupKey,
  classifyPickTicketRows
} from './distropClassifier.js';
import { PickTicketExpectationStore } from './expectationStore.js';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

const orderNo = String(arg('order-no', '')).trim();
const baselineJobId = Number(arg('baseline-job-id', '0'));
const stateFile = path.resolve(arg(
  'state-file',
  'api/data/pick-ticket-observer/state.json'
));
const stabilizationMs = Number(arg('stabilization-ms', '120000'));

if (!orderNo) {
  throw new Error('Use --order-no. Unbounded VR_ORDER_LI queries are not allowed.');
}
if (!Number.isInteger(baselineJobId) || baselineJobId < 0) {
  throw new Error('--baseline-job-id must be a non-negative integer.');
}

const baseUrl = required(
  'A2000_BASE_URL',
  String(process.env.A2000_BASE_URL || '').replace(/\/+$/, '')
);
const clientId = required(
  'A2000_CLIENT_ID',
  process.env.A2000_CLIENT_ID || process.env.A2000_CLIENTID
);
const clientSecret = required(
  'A2000_CLIENT_SECRET',
  process.env.A2000_CLIENT_SECRET || process.env.A2000_SECRET
);

const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const tokenResponse = await fetch(`${baseUrl}/api/oauth/token`, {
  method: 'POST',
  headers: {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: 'grant_type=client_credentials',
  signal: AbortSignal.timeout(30000)
});
const tokenText = await tokenResponse.text();
let tokenBody;
try { tokenBody = JSON.parse(tokenText); } catch { tokenBody = {}; }
if (!tokenResponse.ok || !tokenBody.access_token) {
  throw new Error(`A2000 OAuth failed: ${tokenResponse.status}`);
}

const safeOrderNo = orderNo.replaceAll("'", "''");
const viewerResponse = await fetch(`${baseUrl}/api/viewers/view/VR_ORDER_LI`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${tokenBody.access_token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    COLUMNS: [
      'CTRL_NO', 'STYLE', 'CLR', 'LINE_NO', 'WH', 'CUSTOMER', 'STORE',
      'ORDER_NO', 'SUMMARY_ORDER_NO', 'DIV', 'PICKTKT', 'PICK_QTY',
      'ORDER_QTY', 'SKU', 'CUST_STYLE1', 'MODIFY_DATE'
    ].join(','),
    FILTER: `ORDER_NO = '${safeOrderNo}'`,
    SORT: 'CTRL_NO,PICKTKT,LINE_NO'
  }),
  signal: AbortSignal.timeout(30000)
});
const viewerText = await viewerResponse.text();
if (!viewerResponse.ok) {
  throw new Error(`VR_ORDER_LI failed: ${viewerResponse.status} ${viewerText.slice(0, 500)}`);
}
const viewerJson = JSON.parse(viewerText);
const rows = viewerJson.VR_ORDER_LI || [];
if (!rows.length) throw new Error(`No VR_ORDER_LI rows found for order ${orderNo}.`);

const grouped = new Map();
for (const row of rows) {
  const key = buildPickTicketGroupKey(row);
  if (!grouped.has(key)) grouped.set(key, []);
  grouped.get(key).push(row);
}

const store = new PickTicketExpectationStore(stateFile);
const previousState = await store.read();

for (const [groupKey, groupRows] of grouped) {
  const previous = previousState.groups?.[groupKey] || {};
  const now = Date.now();
  const firstSeenAt = previous.first_seen_at
    ? Date.parse(previous.first_seen_at)
    : now;
  const classification = classifyPickTicketRows(groupRows, {
    now,
    firstSeenAt,
    lastSeenAt: now,
    stabilizationMs
  });
  const first = groupRows[0];
  const existingExpected = new Map(
    (previous.expected_pick_tickets || []).map((item) => [
      [item.pick_ticket_no, item.control_no, item.order_no, item.store_no].join('|'),
      item
    ])
  );
  const expectedMap = new Map();

  for (const row of groupRows) {
    const pickTicket = String(row.PICKTKT || '').trim();
    if (!pickTicket) continue;
    const item = {
      pick_ticket_no: pickTicket,
      control_no: String(row.CTRL_NO || '').trim(),
      order_no: String(row.ORDER_NO || '').trim(),
      store_no: String(row.STORE || '').trim()
    };
    const key = [item.pick_ticket_no, item.control_no, item.order_no, item.store_no].join('|');
    expectedMap.set(key, {
      ...item,
      status: existingExpected.get(key)?.status || 'WAITING_FOR_RUN',
      matched_job_id: existingExpected.get(key)?.matched_job_id || null,
      matched_pdf_path: existingExpected.get(key)?.matched_pdf_path || null,
      matched_page_number: existingExpected.get(key)?.matched_page_number || null,
      validated_at: existingExpected.get(key)?.validated_at || null
    });
  }

  const group = {
    group_key: groupKey,
    customer_code: String(first.CUSTOMER || '').trim(),
    division_code: String(first.DIV || '').trim(),
    order_no: String(first.SUMMARY_ORDER_NO || first.ORDER_NO || '').trim(),
    classification: classification.classification,
    classification_details: classification,
    checklist_control_no: classification.checklist_control_no,
    checklist_control_identity_type:
      classification.checklist_control_identity_type,
    checklist_control_pending_reason:
      classification.checklist_control_pending_reason,
    first_seen_at: previous.first_seen_at || new Date(now).toISOString(),
    last_seen_at: new Date(now).toISOString(),
    baseline_job_id: Math.max(Number(previous.baseline_job_id || 0), baselineJobId),
    request_timestamp: new Date().toISOString(),
    expected_pick_tickets: [...expectedMap.values()],
    source_rows: groupRows,
    original_report_files: previous.original_report_files || []
  };

  await store.upsertGroup(group);
  console.log(JSON.stringify({
    action: 'EXPECTATIONS_CREATED_OR_UPDATED',
    group_key: group.group_key,
    classification: group.classification,
    has_bulk_parent: classification.has_bulk_parent,
    expected_pick_tickets: group.expected_pick_tickets
  }, null, 2));
}

console.log('A2000_BUSINESS_WRITES_PERFORMED=NO');
console.log('A2000_VIEWER_READ_PERFORMED=YES');
console.log(`STATE_FILE=${stateFile}`);
