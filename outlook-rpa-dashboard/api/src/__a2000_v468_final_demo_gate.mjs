import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';
import { loadMasterData } from './po/enrichment/masterData.js';
import { A2000RestAdapter } from './a2000/restAdapter.js';
import { processDownloadedDocuments } from './po/poRepository.js';
import { runScan } from './runScan.js';
import {
  listOperationsLog
} from './po/productionWorkflow.js';
import { supabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..', '..');
const API = path.join(PROJECT, 'api');
const SOURCE_ROOT = path.join(API, 'training', 'all_customer_source_fixtures');
const PARSER_ROOT = path.join(API, 'training', 'parser_fixture_pdfs');
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const OUT = path.join('/tmp', `a2000_v468_final_demo_gate_${RUN_ID}`);
await fs.mkdir(OUT, { recursive: true });

const REQUIRED_CUSTOMERS = Object.freeze([
  '10BELOW',
  'BEALLSOUTL',
  'CITI',
  'GABRIELBRO',
  'ITSFASHION',
  'MESALVEINC',
  'OLLIES',
  'VARIETYWHO',
  'VERSONA',
  'ZUMIEZ'
]);

const TARGETS = [
  ['10BELOW', SOURCE_ROOT, '10 below/72041 American Exchange PO.pdf'],
  ['BEALLSOUTL', SOURCE_ROOT, 'beallsoutl/hardcopie nueva.pdf'],
  ['BEALLSOUTL', SOURCE_ROOT, 'beallsoutl/hardcopie vieja.PDF'],
  ['CITI', SOURCE_ROOT, 'citi/PurchaseOrder-0000199431-00-009721.pdf'],
  ['GABRIELBRO', SOURCE_ROOT, 'gabrielbro/VendorCopy_13003334.pdf'],
  ['ITSFASHION', SOURCE_ROOT, 'ITSFASHION/stainless steel AMEX PO.pdf'],
  ['MESALVEINC', SOURCE_ROOT, 'MESALVEINC/reportPO-24027385.pdf'],
  ['OLLIES', SOURCE_ROOT, 'OLLIES/POLINK 1.pdf'],
  ['OLLIES', PARSER_ROOT, 'PO #952211.pdf'],
  ['VARIETYWHO', SOURCE_ROOT, 'VARIETYWHO/1885387.pdf'],
  ['VERSONA', SOURCE_ROOT, 'Versona/615628 earlier ship.pdf'],
  ['ZUMIEZ', SOURCE_ROOT, 'ZUMIEZ/4587_476085_20260204134804 LINKIN PARK 1.pdf']
];

const EXPECTED_EMAIL_PDFS = [
  '1885387.pdf',
  '615628 earlier ship.pdf',
  '4587_476085_20260204134804 LINKIN PARK 1.pdf',
  '72041 American Exchange PO.pdf',
  'hardcopie nueva.pdf',
  'PurchaseOrder-0000199431-00-009721.pdf',
  'POLINK 1.pdf',
  'hardcopie.PDF'
];

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function upper(value) {
  return clean(value).toUpperCase();
}

function activeBuckets(line = {}) {
  const buckets = {};
  for (let index = 1; index <= 18; index += 1) {
    const value = Number(line[`qty_sz${index}`] || 0);
    if (Number.isFinite(value) && value > 0) buckets[`QTY_SZ${index}`] = value;
  }
  return buckets;
}

function exactNativePair(line, masters) {
  const style = upper(line.style_code);
  const color = upper(line.color_code);
  if (!style || !color) return false;

  return (masters.skuByStyle.get(style) || [])
    .some(row => upper(row.Clr) === color);
}

function normalizeOrder(order) {
  return {
    customer_code: order.header?.customer_code,
    store_code: order.header?.store_code,
    order_no: order.header?.order_no,
    order_date: order.header?.order_date,
    start_date: order.header?.start_date,
    cancel_date: order.header?.cancel_date,
    division_code: order.header?.division_code,
    terms_code: order.header?.terms_code,
    warehouse_code: order.header?.warehouse_code,
    ship_via_code: order.header?.ship_via_code,
    status: order.status,
    purchase_order_lines: order.lines || []
  };
}

function preflightErrors(preflight = {}) {
  return [
    ...(preflight.validation?.errors || []),
    ...(preflight.source_guard?.errors || []),
    ...(preflight.live_scale_validation?.lines || []).flatMap(line => line.errors || [])
  ];
}

const masters = loadMasterData();
if (!masters.loaded) {
  throw new Error(`MASTER_NOT_LOADED:${masters.error || 'UNKNOWN'}`);
}

const adapter = new A2000RestAdapter();
const report = {
  audit: 'A2000_V4_6_8_FINAL_DEMO_RECOVERY_10_CUSTOMER_GATE',
  run_id: RUN_ID,
  a2000_writes_performed: false,
  supabase_recovery_writes_performed: true,
  canonical: [],
  scan: null,
  current_versona: null,
  current_citi: null,
  log_detail: null,
  completed_history: {}
};

for (const [expectedCustomer, root, rel] of TARGETS) {
  const fixturePath = path.join(root, rel);
  const buffer = await fs.readFile(fixturePath);
  const text = await extractPdfTextFromBuffer(buffer);

  // Deliberately use generic email metadata. Customer detection must come from
  // the hardcopy/parser and, for Cato-family image logos, the visual fingerprint.
  const orders = parsePurchaseOrders({
    text,
    fileName: path.basename(fixturePath),
    document: {
      file_name: path.basename(fixturePath),
      subject: 'factura american',
      source: 'v468_canonical_no_customer_hint'
    }
  });

  for (const order of orders) {
    const normalized = normalizeOrder(order);
    let preflight = null;
    let preflightException = null;

    try {
      preflight = await adapter.preflight(normalized);
    } catch (error) {
      preflightException = error?.message || String(error);
    }

    const lines = order.lines || [];
    report.canonical.push({
      expected_customer: expectedCustomer,
      actual_customer: order.header?.customer_code || null,
      source: rel,
      order_no: order.header?.order_no || null,
      status: order.status || null,
      line_count: lines.length,
      native_count: lines.filter(line => exactNativePair(line, masters)).length,
      qty_bucket_count: lines.filter(line => Object.keys(activeBuckets(line)).length > 0).length,
      preflight_valid: preflight?.valid === true,
      preflight_errors: preflight ? preflightErrors(preflight) : [],
      preflight_exception: preflightException,
      lines: lines.map(line => ({
        line_no: line.line_no,
        style: line.style_code || null,
        color: line.color_code || null,
        qty_total: line.qty_total ?? null,
        buckets: activeBuckets(line)
      }))
    });
  }
}

const scanResult = await runScan();

const { data: allInvoiceDocuments, error: docsError } = await supabase
  .from('documents')
  .select('id, file_name, subject, status, sha256, created_at')
  .ilike('subject', '%factura american%')
  .order('created_at', { ascending: false })
  .limit(500);

if (docsError) throw docsError;

const docs = allInvoiceDocuments || [];
const presentNames = new Map();

for (const doc of docs) {
  const key = clean(doc.file_name).toLowerCase();
  if (key && !presentNames.has(key)) presentNames.set(key, doc);
}

const expectedPresence = EXPECTED_EMAIL_PDFS.map(fileName => ({
  file_name: fileName,
  present: presentNames.has(fileName.toLowerCase()),
  document_id: presentNames.get(fileName.toLowerCase())?.id || null
}));

report.scan = {
  status: scanResult.run?.status || null,
  matching_emails: scanResult.emails?.length || 0,
  downloaded_pdfs: scanResult.documents?.length || 0,
  auto_processed: scanResult.processing?.processed_document_count || 0,
  expected_presence: expectedPresence,
  present_count: expectedPresence.filter(item => item.present).length,
  expected_count: expectedPresence.length,
  missing: expectedPresence.filter(item => !item.present).map(item => item.file_name),
  logs: (scanResult.logs || []).filter(line => (
    /ATTACHMENT|PDF|EXPAND|MISSING|RECOVER/i.test(String(line))
  ))
};

for (const focusFileName of [
  '615628 earlier ship.pdf',
  'PurchaseOrder-0000194450-00-080900.pdf'
]) {
  const doc = presentNames.get(focusFileName.toLowerCase());
  if (doc) {
    await processDownloadedDocuments({
      limit: 1,
      documentId: doc.id
    });
  }
}

const { data: versonaRows, error: versonaError } = await supabase
  .from('purchase_orders')
  .select('*, purchase_order_lines(*)')
  .eq('order_no', '615628')
  .order('created_at', { ascending: false })
  .limit(20);

if (versonaError) throw versonaError;

const currentVersona = (versonaRows || []).find(order => (
  upper(order.customer_code) === 'VERSONA'
)) || (versonaRows || [])[0] || null;

if (currentVersona) {
  let preflight = null;
  let exception = null;
  try {
    preflight = await adapter.preflight(currentVersona);
  } catch (error) {
    exception = error?.message || String(error);
  }

  report.current_versona = {
    purchase_order_id: currentVersona.id,
    customer_code: currentVersona.customer_code,
    order_no: currentVersona.order_no,
    status: currentVersona.status,
    line_count: currentVersona.purchase_order_lines?.length || 0,
    native_count: (currentVersona.purchase_order_lines || []).filter(line => exactNativePair(line, masters)).length,
    qty_bucket_count: (currentVersona.purchase_order_lines || []).filter(line => Object.keys(activeBuckets(line)).length > 0).length,
    live_preflight_valid: preflight?.valid === true,
    preflight_errors: preflight ? preflightErrors(preflight) : [],
    preflight_exception: exception
  };
}

const { data: citiRows, error: citiError } = await supabase
  .from('purchase_orders')
  .select('*, purchase_order_lines(*)')
  .eq('customer_code', 'CITI')
  .eq('order_no', '0000194450')
  .order('created_at', { ascending: false })
  .limit(20);

if (citiError) throw citiError;

const currentCiti = (citiRows || [])[0] || null;

if (currentCiti) {
  let preflight = null;
  let exception = null;
  try {
    preflight = await adapter.preflight(currentCiti);
  } catch (error) {
    exception = error?.message || String(error);
  }

  report.current_citi = {
    purchase_order_id: currentCiti.id,
    customer_code: currentCiti.customer_code,
    order_no: currentCiti.order_no,
    status: currentCiti.status,
    line_count: currentCiti.purchase_order_lines?.length || 0,
    live_preflight_valid: preflight?.valid === true,
    preflight_errors: preflight ? preflightErrors(preflight) : [],
    preflight_exception: exception
  };
}

const operationsLog = await listOperationsLog({ limit: 1000 });
const completedJobs = operationsLog.filter(job => job.status === 'completed');

for (const code of REQUIRED_CUSTOMERS) {
  const jobs = completedJobs.filter(job => upper(job.customer_code) === code);
  report.completed_history[code] = jobs.map(job => ({
    order_no: job.order_no,
    ctrl: job.a2000_ctrl_no,
    seq: job.a2000_seq_order_no,
    line_count: job.uploaded_line_count,
    qty: job.uploaded_total_qty
  }));
}

const currentCitiJob = operationsLog.find(job => (
  upper(job.customer_code) === 'CITI'
  && clean(job.order_no) === '0000194450'
  && job.status === 'completed'
));

if (currentCitiJob) {
  report.log_detail = {
    order_no: currentCitiJob.order_no,
    ctrl: currentCitiJob.a2000_ctrl_no,
    seq: currentCitiJob.a2000_seq_order_no,
    line_count: currentCitiJob.uploaded_line_count,
    total_qty: currentCitiJob.uploaded_total_qty,
    styles: (currentCitiJob.uploaded_lines || []).map(line => ({
      line_no: line.line_no,
      style: line.style,
      color: line.color_no,
      qty: line.qty_total,
      qty_buckets: line.qty_buckets
    })),
    header_result: currentCitiJob.header_result,
    lines_result: currentCitiJob.lines_result
  };
}

function customerAggregate(customer) {
  const rows = report.canonical.filter(row => row.expected_customer === customer);
  const lines = rows.flatMap(row => row.lines || []);

  return {
    customer,
    orders: rows.length,
    parsed: rows.filter(row => row.status === 'parsed').length,
    identity_correct: rows.filter(row => row.actual_customer === customer).length,
    lines: lines.length,
    native: rows.reduce((sum, row) => sum + row.native_count, 0),
    qty_buckets: rows.reduce((sum, row) => sum + row.qty_bucket_count, 0),
    preflight_valid: rows.filter(row => row.preflight_valid).length,
    blockers: rows.flatMap(row => [
      ...(row.preflight_errors || []),
      ...(row.preflight_exception ? [{ code: 'PREFLIGHT_EXCEPTION', message: row.preflight_exception }] : [])
    ])
  };
}

const matrix = REQUIRED_CUSTOMERS.map(customerAggregate);
const canonicalOrderCount = report.canonical.length;
const canonicalLineCount = report.canonical.reduce((sum, row) => sum + row.line_count, 0);
const canonicalNativeCount = report.canonical.reduce((sum, row) => sum + row.native_count, 0);
const canonicalQtyCount = report.canonical.reduce((sum, row) => sum + row.qty_bucket_count, 0);
const canonicalParsedCount = report.canonical.filter(row => row.status === 'parsed').length;
const canonicalPreflightCount = report.canonical.filter(row => row.preflight_valid).length;
const canonicalIdentityCount = report.canonical.filter(row => row.actual_customer === row.expected_customer).length;

const canonicalValid = (
  matrix.every(item => (
    item.orders > 0
    && item.parsed === item.orders
    && item.identity_correct === item.orders
    && item.native === item.lines
    && item.qty_buckets === item.lines
    && item.preflight_valid === item.orders
  ))
  && canonicalOrderCount === 17
  && canonicalLineCount === 70
);

const attachmentsValid = report.scan.present_count === report.scan.expected_count;
const versonaValid = (
  report.current_versona?.customer_code === 'VERSONA'
  && report.current_versona?.order_no === '615628'
  && report.current_versona?.status === 'parsed'
  && report.current_versona?.line_count === 2
  && report.current_versona?.native_count === 2
  && report.current_versona?.qty_bucket_count === 2
  && report.current_versona?.live_preflight_valid === true
);

const citiValid = (
  report.current_citi?.status === 'parsed'
  && report.current_citi?.line_count === 4
  && report.current_citi?.live_preflight_valid === true
);

const logDetailValid = (
  report.log_detail?.line_count === 4
  && report.log_detail?.total_qty === 2400
  && Boolean(report.log_detail?.ctrl)
  && Boolean(report.log_detail?.seq)
  && report.log_detail?.styles?.length === 4
);

report.final = {
  canonical_valid: canonicalValid,
  attachments_valid: attachmentsValid,
  versona_valid: versonaValid,
  citi_current_valid: citiValid,
  log_detail_valid: logDetailValid,
  final_valid: (
    canonicalValid
    && attachmentsValid
    && versonaValid
    && citiValid
    && logDetailValid
  )
};

await fs.writeFile(
  path.join(OUT, 'FULL_REPORT.json'),
  JSON.stringify(report, null, 2),
  'utf8'
);

const lines = [
  '='.repeat(120),
  'COPY THIS RESULT TO CHATGPT',
  '='.repeat(120),
  `AUDIT=${report.audit}`,
  `RUN_ID=${RUN_ID}`,
  'A2000_WRITES_PERFORMED=NO',
  'SUPABASE_RECOVERY_WRITES_PERFORMED=YES',
  '',
  '=== REQUIRED 10 CURRENT CODE + CANONICAL HARDCOPY + LIVE PREFLIGHT ===',
  `CANONICAL_ORDER_COUNT=${canonicalOrderCount}`,
  `CANONICAL_LINE_COUNT=${canonicalLineCount}`,
  `CANONICAL_PARSED=${canonicalParsedCount}/${canonicalOrderCount}`,
  `CANONICAL_CUSTOMER_IDENTITY=${canonicalIdentityCount}/${canonicalOrderCount}`,
  `CANONICAL_NATIVE_STYLE_COLOR=${canonicalNativeCount}/${canonicalLineCount}`,
  `CANONICAL_QTY_BUCKETS=${canonicalQtyCount}/${canonicalLineCount}`,
  `CANONICAL_LIVE_PREFLIGHT=${canonicalPreflightCount}/${canonicalOrderCount}`
];

for (const item of matrix) {
  lines.push([
    'CUSTOMER',
    `CODE=${item.customer}`,
    `ORDERS=${item.orders}`,
    `PARSED=${item.parsed}/${item.orders}`,
    `IDENTITY=${item.identity_correct}/${item.orders}`,
    `LINES=${item.lines}`,
    `NATIVE=${item.native}/${item.lines}`,
    `QTY_BUCKETS=${item.qty_buckets}/${item.lines}`,
    `LIVE_PREFLIGHT=${item.preflight_valid}/${item.orders}`,
    `BLOCKERS=${JSON.stringify(item.blockers)}`
  ].join('|'));
}

lines.push('');
lines.push('=== VERSONA VISUAL BRAND / CURRENT PDF ===');
lines.push(`VERSONA_CURRENT=${JSON.stringify(report.current_versona)}`);
lines.push(`VERSONA_VALID=${versonaValid}`);

lines.push('');
lines.push('=== OUTLOOK COLLAPSED MULTI-ATTACHMENT RECOVERY ===');
lines.push(`SCAN_STATUS=${report.scan.status}`);
lines.push(`SCAN_MATCHING_EMAILS=${report.scan.matching_emails}`);
lines.push(`SCAN_DOWNLOADED_PDFS=${report.scan.downloaded_pdfs}`);
lines.push(`OUTLOOK_EXPECTED_PDFS_PRESENT=${report.scan.present_count}/${report.scan.expected_count}`);
lines.push(`OUTLOOK_MISSING_EXPECTED_PDFS=${JSON.stringify(report.scan.missing)}`);
for (const line of report.scan.logs) lines.push(`SCAN_LOG=${line}`);

lines.push('');
lines.push('=== CURRENT CITI 0000194450 + ACTUAL A2000 LOG DETAIL ===');
lines.push(`CITI_CURRENT=${JSON.stringify(report.current_citi)}`);
lines.push(`CITI_CURRENT_VALID=${citiValid}`);
lines.push(`CITI_COMPLETED_LOG_DETAIL=${JSON.stringify(report.log_detail)}`);
lines.push(`LOG_DETAIL_VALID=${logDetailValid}`);

lines.push('');
lines.push('=== COMPLETED A2000 HISTORY BY REQUIRED CUSTOMER ===');
for (const code of REQUIRED_CUSTOMERS) {
  lines.push(`COMPLETED_HISTORY|CUSTOMER=${code}|JOBS=${JSON.stringify(report.completed_history[code] || [])}`);
}

lines.push('');
lines.push('=== AUTH + WRITE SAFETY ===');
lines.push('VIEWER_401_FORCED_REFRESH_ATTEMPTS=2');
lines.push('UPLOAD_FRESH_OAUTH_BEFORE_EACH_POST=YES');
lines.push('UPLOAD_POST_BLIND_RETRY=NO');
lines.push('CURRENT_GATE_A2000_WRITES_PERFORMED=NO');

lines.push('');
lines.push('=== FINAL ===');
lines.push(`CANONICAL_10_CUSTOMER_GATE_VALID=${canonicalValid}`);
lines.push(`OUTLOOK_8_OF_8_VALID=${attachmentsValid}`);
lines.push(`VERSONA_CURRENT_VALID=${versonaValid}`);
lines.push(`CITI_CURRENT_VALID=${citiValid}`);
lines.push(`DETAILED_LOG_VALID=${logDetailValid}`);
lines.push(`FINAL_VALID=${report.final.final_valid}`);
lines.push(`FULL_REPORT=${path.join(OUT, 'FULL_REPORT.json')}`);
lines.push(`GATE_DIR=${OUT}`);
lines.push(
  `NEXT=${report.final.final_valid ? 'RESTART_API_WEB_AND_USE_ONE_CLICK_AMEXTEST_DEMO' : 'PASTE_THIS_OUTPUT_FIX_ONLY_REMAINING_EXACT_RUNTIME_GAP'}`
);
lines.push('='.repeat(120));

const copyText = lines.join('\n') + '\n';
await fs.writeFile(path.join(OUT, 'COPY_TO_CHATGPT.txt'), copyText, 'utf8');

console.log(copyText);
console.log(`COPY_FILE=${path.join(OUT, 'COPY_TO_CHATGPT.txt')}`);
console.log(`FULL_REPORT=${path.join(OUT, 'FULL_REPORT.json')}`);

process.exitCode = report.final.final_valid ? 0 : 2;
