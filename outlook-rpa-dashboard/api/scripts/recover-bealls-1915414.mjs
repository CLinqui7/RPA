import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { supabase } from '../src/supabase.js';
import { extractPdfTextFromBuffer, extractPdfTextFromDocument } from '../src/po/pdfText.js';
import { parsePurchaseOrder } from '../src/po/parsers/index.js';
import { processDownloadedDocuments } from '../src/po/poRepository.js';
import { parsedLineSafetyReport } from '../src/po/parsedLineSafety.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');
const APPLY = process.argv.includes('--apply');
const TOOL_VERSION = '1.1.0';
const EXPECTED_SOURCE_SHA256 = '2324a85a2632a1e97c80b667750d257c777f61216cc80d7528e440e5954630c5';
const DEFAULT_PRIVATE_SOURCE = path.join(
  process.env.HOME || '/tmp',
  '.local', 'share', 'outlook-rpa-dashboard', 'recovery-sources',
  'BEALLSOUTL', '1915414',
  'AMERICAN EXCHANGE-Dept#3270 -PO#1915414-DT#06022026-163035.PDF'
);
const EXPECTED = {
  customer_code: 'BEALLSOUTL',
  order_no: '1915414',
  store_code: '115',
  dept_raw: '270',
  line_count: 5,
  qty: 340,
  amount: 4700,
  lines: [
    ['492961', 'EHH358-26', '003', 60],
    ['492986', 'EHH381-42', '060', 80],
    ['492974', 'EHH411A-42', '003', 80],
    ['493005', 'EHH413-42', 'BMT', 60],
    ['492998', 'EHH415-42', '085', 60]
  ]
};

function clean(value) {
  return String(value ?? '').trim();
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] || null : null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function toJson(value) {
  return value === undefined ? null : value;
}

function summarizeLine(line) {
  return {
    customer_sku: clean(line.customer_sku) || null,
    style_raw: clean(line.style_raw) || null,
    style_code: clean(line.style_code) || null,
    color_raw: clean(line.color_raw) || null,
    color_code: clean(line.color_code) || null,
    description: clean(line.description) || null,
    qty_total: Number(line.qty_total || 0),
    qty_sz1: Number(line.qty_sz1 || 0),
    sales_price: Number(line.sales_price || 0),
    warehouse_code: clean(line.warehouse_code) || null
  };
}

function validateExactBealls(parsed) {
  const safety = parsedLineSafetyReport(parsed);
  const lines = Array.isArray(parsed.lines) ? parsed.lines : [];
  const failures = [];

  if (!safety.ok) failures.push(safety.code);
  if (clean(parsed.header?.customer_code) !== EXPECTED.customer_code) failures.push('CUSTOMER_MISMATCH');
  if (clean(parsed.header?.order_no) !== EXPECTED.order_no) failures.push('ORDER_MISMATCH');
  if (clean(parsed.header?.store_code || parsed.header?.store_raw) !== EXPECTED.store_code) failures.push('STORE_MISMATCH');
  if (clean(parsed.header?.dept_raw || parsed.header?.dept_code) !== EXPECTED.dept_raw) failures.push('DEPARTMENT_MISMATCH');
  if (lines.length !== EXPECTED.line_count) failures.push('LINE_COUNT_MISMATCH');
  if (Number(parsed.totals?.qty || 0) !== EXPECTED.qty) failures.push('TOTAL_QTY_MISMATCH');
  if (Math.abs(Number(parsed.totals?.amount || 0) - EXPECTED.amount) > 0.01) failures.push('TOTAL_AMOUNT_MISMATCH');

  for (const [sku, style, color, qty] of EXPECTED.lines) {
    const match = lines.find(line =>
      clean(line.customer_sku) === sku
      && clean(line.style_code) === style
      && clean(line.color_code) === color
      && Number(line.qty_total || 0) === qty
    );
    if (!match) failures.push(`EXPECTED_LINE_MISSING:${sku}:${style}:${color}:${qty}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    safety,
    header: {
      customer_code: parsed.header?.customer_code || null,
      order_no: parsed.header?.order_no || null,
      store_code: parsed.header?.store_code || parsed.header?.store_raw || null,
      dept_raw: parsed.header?.dept_raw || parsed.header?.dept_code || null,
      division_code: parsed.header?.division_code || null,
      terms_code: parsed.header?.terms_code || null,
      ship_via_code: parsed.header?.ship_via_code || null,
      warehouse_code: parsed.header?.warehouse_code || null
    },
    totals: parsed.totals || {},
    lines: lines.map(summarizeLine),
    conflicts: parsed.conflicts || [],
    status: parsed.status || null,
    layout_version: parsed.layout_version || null
  };
}

async function loadOrders() {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('customer_code', EXPECTED.customer_code)
    .eq('order_no', EXPECTED.order_no)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

async function loadDocumentsByIds(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .in('id', ids);
  if (error) throw error;
  return data || [];
}

async function searchDocumentsByPo() {
  const warnings = [];
  const documents = [];
  const seen = new Set();
  const add = rows => {
    for (const row of rows || []) {
      if (!row?.id || seen.has(row.id)) continue;
      seen.add(row.id);
      documents.push(row);
    }
  };

  const fileQuery = await supabase
    .from('documents')
    .select('*')
    .ilike('file_name', `%${EXPECTED.order_no}%`)
    .limit(50);
  if (fileQuery.error) warnings.push(`DOCUMENT_FILENAME_SEARCH_FAILED:${fileQuery.error.message}`);
  else add(fileQuery.data);

  const poQuery = await supabase
    .from('documents')
    .select('*')
    .ilike('detected_po', `%${EXPECTED.order_no}%`)
    .limit(50);
  if (poQuery.error) warnings.push(`DOCUMENT_PO_SEARCH_FAILED:${poQuery.error.message}`);
  else add(poQuery.data);

  return { documents, warnings };
}

async function parseDocumentCandidate(document, sourceType = 'supabase_document') {
  try {
    const text = await extractPdfTextFromDocument(document);
    const parsed = parsePurchaseOrder({ text, fileName: document.file_name, document });
    return {
      source_type: sourceType,
      document,
      source_path: null,
      source_sha256: document.sha256 || null,
      text_length: text.length,
      parsed,
      validation: validateExactBealls(parsed)
    };
  } catch (error) {
    return {
      source_type: sourceType,
      document,
      source_path: null,
      source_sha256: document.sha256 || null,
      text_length: 0,
      parsed: null,
      validation: { ok: false, failures: [`PARSE_EXCEPTION:${error.message}`] }
    };
  }
}

async function parseLocalCandidate(sourcePath) {
  const fileName = path.basename(sourcePath);
  try {
    const buffer = await fs.readFile(sourcePath);
    const actualSha256 = sha256(buffer);
    if (actualSha256 !== EXPECTED_SOURCE_SHA256) {
      return {
        source_type: 'private_certified_pdf',
        document: null,
        source_path: sourcePath,
        source_sha256: actualSha256,
        text_length: 0,
        parsed: null,
        validation: {
          ok: false,
          failures: [`SOURCE_PDF_SHA256_MISMATCH:${actualSha256}`]
        }
      };
    }

    const text = await extractPdfTextFromBuffer(buffer);
    const pseudoDocument = {
      id: null,
      file_name: fileName,
      recovery_source: 'private_certified_pdf',
      sha256: actualSha256
    };
    const parsed = parsePurchaseOrder({ text, fileName, document: pseudoDocument });
    return {
      source_type: 'private_certified_pdf',
      document: null,
      source_path: sourcePath,
      source_sha256: actualSha256,
      text_length: text.length,
      parsed,
      validation: validateExactBealls(parsed)
    };
  } catch (error) {
    return {
      source_type: 'private_certified_pdf',
      document: null,
      source_path: sourcePath,
      source_sha256: null,
      text_length: 0,
      parsed: null,
      validation: { ok: false, failures: [`LOCAL_SOURCE_EXCEPTION:${error.message}`] }
    };
  }
}

function candidateSummary(candidate) {
  return {
    source_type: candidate.source_type,
    document_id: candidate.document?.id || null,
    file_name: candidate.document?.file_name || path.basename(candidate.source_path || ''),
    storage_bucket: candidate.document?.storage_bucket || null,
    storage_path: candidate.document?.storage_path || null,
    private_source_path: candidate.source_path || null,
    source_sha256: candidate.source_sha256 || null,
    text_length: candidate.text_length,
    validation: candidate.validation
  };
}

function orderPatchFromParsed(parsed, source) {
  const header = parsed.header || {};
  return {
    source_file_name: source.file_name,
    parser_name: parsed.parser,
    parser_confidence: parsed.confidence,
    status: parsed.status || 'needs_mapping',
    customer_raw: header.customer_raw || null,
    customer_code: header.customer_code || null,
    order_no: header.order_no || null,
    order_date: header.order_date || null,
    start_date: header.start_date || null,
    cancel_date: header.cancel_date || null,
    book_date: header.book_date || null,
    dept_raw: header.dept_raw || null,
    dept_code: header.dept_code || null,
    division_code: header.division_code || null,
    store_raw: header.store_raw || null,
    store_code: header.store_code || null,
    terms_raw: header.terms_raw || null,
    terms_code: header.terms_code || null,
    ship_via_code: header.ship_via_code || null,
    warehouse_code: header.warehouse_code || null,
    totals: toJson(parsed.totals || {}),
    missing_fields: toJson(parsed.needs_mapping || {}),
    conflicts: toJson(parsed.conflicts || []),
    raw_json: toJson({
      ...parsed,
      recovery_provenance: {
        tool: 'recover-bealls-1915414.mjs',
        tool_version: TOOL_VERSION,
        source_type: source.source_type,
        source_file_name: source.file_name,
        source_sha256: source.source_sha256,
        recovered_at: new Date().toISOString()
      }
    })
  };
}

function lineRowsFromParsed(orderId, parsed) {
  const header = parsed.header || {};
  return (parsed.lines || []).map(line => ({
    purchase_order_id: orderId,
    document_id: null,
    order_no: header.order_no || null,
    line_no: line.line_no,
    customer_sku: line.customer_sku || null,
    ticket_sku: line.ticket_sku || null,
    style_raw: line.style_raw || null,
    style_code: line.style_code || null,
    color_raw: line.color_raw || null,
    color_code: line.color_code || null,
    description: line.description || null,
    size_raw: line.size_raw || null,
    size_code: line.size_code || null,
    sales_price: line.sales_price,
    list_price: line.list_price || null,
    qty_total: line.qty_total,
    qty_sz1: line.qty_sz1 ?? null,
    qty_sz2: line.qty_sz2 || null,
    qty_sz3: line.qty_sz3 || null,
    qty_sz4: line.qty_sz4 || null,
    qty_sz5: line.qty_sz5 || null,
    qty_sz6: line.qty_sz6 || null,
    qty_sz7: line.qty_sz7 || null,
    qty_sz8: line.qty_sz8 || null,
    qty_sz9: line.qty_sz9 || null,
    qty_sz10: line.qty_sz10 || null,
    qty_sz11: line.qty_sz11 || null,
    qty_sz12: line.qty_sz12 || null,
    qty_sz13: line.qty_sz13 || null,
    qty_sz14: line.qty_sz14 || null,
    qty_sz15: line.qty_sz15 || null,
    qty_sz16: line.qty_sz16 || null,
    qty_sz17: line.qty_sz17 || null,
    qty_sz18: line.qty_sz18 || null,
    warehouse_code: line.warehouse_code || null,
    missing_fields: toJson(line.missing_fields || []),
    raw_json: toJson(line.raw || line)
  }));
}

function originalWritablePatch(order) {
  const fields = [
    'source_file_name', 'parser_name', 'parser_confidence', 'status',
    'customer_raw', 'customer_code', 'order_no', 'order_date', 'start_date',
    'cancel_date', 'book_date', 'dept_raw', 'dept_code', 'division_code',
    'store_raw', 'store_code', 'terms_raw', 'terms_code', 'ship_via_code',
    'warehouse_code', 'totals', 'missing_fields', 'conflicts', 'raw_json'
  ];
  return Object.fromEntries(fields.map(field => [field, order[field] ?? null]));
}

async function persistPrivateCandidate(candidate, beforeOrders) {
  if (!beforeOrders.length) {
    throw new Error('BEALLS_RECOVERY_ORDER_ROW_NOT_FOUND');
  }
  if (beforeOrders.some(order => (order.purchase_order_lines || []).length > 0)) {
    throw new Error('BEALLS_RECOVERY_PRIVATE_SOURCE_REFUSES_TO_OVERWRITE_EXISTING_LINES');
  }

  const target = beforeOrders[0];
  const originalPatch = originalWritablePatch(target);
  const newPatch = orderPatchFromParsed(candidate.parsed, {
    source_type: candidate.source_type,
    file_name: path.basename(candidate.source_path),
    source_sha256: candidate.source_sha256
  });
  const rows = lineRowsFromParsed(target.id, candidate.parsed);

  if (rows.length !== EXPECTED.line_count) {
    throw new Error(`BEALLS_RECOVERY_LINE_BUILD_MISMATCH:${rows.length}`);
  }

  const { error: deleteError } = await supabase
    .from('purchase_order_lines')
    .delete()
    .eq('purchase_order_id', target.id);
  if (deleteError) throw deleteError;

  let orderUpdated = false;
  try {
    const { error: updateError } = await supabase
      .from('purchase_orders')
      .update(newPatch)
      .eq('id', target.id);
    if (updateError) throw updateError;
    orderUpdated = true;

    const { error: insertError } = await supabase
      .from('purchase_order_lines')
      .insert(rows);
    if (insertError) throw insertError;
  } catch (error) {
    try {
      await supabase
        .from('purchase_order_lines')
        .delete()
        .eq('purchase_order_id', target.id);
    } catch {}
    if (orderUpdated) {
      try {
        await supabase
          .from('purchase_orders')
          .update(originalPatch)
          .eq('id', target.id);
      } catch {}
    }
    throw error;
  }

  return {
    mode: 'private_certified_pdf_direct_persistence',
    target_purchase_order_id: target.id,
    inserted_line_count: rows.length,
    source_file_name: path.basename(candidate.source_path),
    source_sha256: candidate.source_sha256
  };
}

async function verifyPersistedOrders() {
  const afterOrders = await loadOrders();
  const recovered = afterOrders.find(order => {
    const lines = order.purchase_order_lines || [];
    const qty = lines.reduce((sum, line) => sum + Number(line.qty_total || 0), 0);
    const exactLines = EXPECTED.lines.every(([sku, style, color, expectedQty]) =>
      lines.some(line =>
        clean(line.customer_sku) === sku
        && clean(line.style_code) === style
        && clean(line.color_code) === color
        && Number(line.qty_total || 0) === expectedQty
      )
    );
    return lines.length === EXPECTED.line_count && qty === EXPECTED.qty && exactLines;
  });
  return { afterOrders, recovered };
}

const beforeOrders = await loadOrders();
const linkedDocumentIds = [...new Set(beforeOrders.map(order => order.document_id).filter(Boolean))];
const linkedDocuments = await loadDocumentsByIds(linkedDocumentIds);
const searched = await searchDocumentsByPo();
const allDocuments = [];
const seenDocumentIds = new Set();
for (const document of [...linkedDocuments, ...searched.documents]) {
  if (!document?.id || seenDocumentIds.has(document.id)) continue;
  seenDocumentIds.add(document.id);
  allDocuments.push(document);
}

const candidates = [];
for (const document of allDocuments) {
  candidates.push(await parseDocumentCandidate(
    document,
    linkedDocumentIds.includes(document.id) ? 'linked_supabase_document' : 'searched_supabase_document'
  ));
}

const sourcePdf = path.resolve(
  argValue('--source-pdf')
    || process.env.BEALLS_RECOVERY_SOURCE_PDF
    || DEFAULT_PRIVATE_SOURCE
);
const localCandidate = await parseLocalCandidate(sourcePdf);
candidates.push(localCandidate);

const validCandidates = candidates.filter(candidate => candidate.validation.ok);
const selected = validCandidates.find(candidate => candidate.source_type !== 'private_certified_pdf')
  || validCandidates.find(candidate => candidate.source_type === 'private_certified_pdf')
  || null;

const report = {
  tool_version: TOOL_VERSION,
  mode: APPLY ? 'APPLY' : 'DRY_RUN',
  expected: EXPECTED,
  purchase_order_row_count: beforeOrders.length,
  existing_line_counts: beforeOrders.map(order => ({
    purchase_order_id: order.id,
    document_id: order.document_id,
    line_count: order.purchase_order_lines?.length || 0,
    created_at: order.created_at
  })),
  linked_document_count: linkedDocuments.length,
  searched_document_count: searched.documents.length,
  document_search_warnings: searched.warnings,
  private_source_path: sourcePdf,
  private_source_expected_sha256: EXPECTED_SOURCE_SHA256,
  valid_source_count: validCandidates.length,
  selected_source_type: selected?.source_type || null,
  candidates: candidates.map(candidateSummary)
};

console.log(JSON.stringify(report, null, 2));

if (!APPLY) {
  console.error('\nDRY-RUN ONLY. No database rows, checklist files, or A2000 records were changed.');
  console.error('Apply only when valid_source_count is at least 1 and the selected candidate contains all five certified lines.');
  process.exit(selected ? 0 : 3);
}

if (!selected) {
  console.error('\nRECOVERY BLOCKED: neither Supabase nor the private certified PDF parsed to the exact Bealls values.');
  process.exit(3);
}

const backupDir = path.join(API_ROOT, 'backups', `bealls-1915414-before-recovery-${stamp()}`);
await fs.mkdir(backupDir, { recursive: true });
await fs.writeFile(path.join(backupDir, 'database-snapshot.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  purchase_orders: beforeOrders,
  source_documents: allDocuments.map(document => ({
    id: document.id,
    file_name: document.file_name,
    storage_bucket: document.storage_bucket,
    storage_path: document.storage_path,
    sha256: document.sha256 || null
  }))
}, null, 2));
await fs.writeFile(path.join(backupDir, 'certified-live-parse.json'), JSON.stringify(selected.validation, null, 2));
if (selected.source_type === 'private_certified_pdf') {
  await fs.copyFile(selected.source_path, path.join(backupDir, path.basename(selected.source_path)));
}

let processing;
if (selected.source_type === 'private_certified_pdf') {
  processing = await persistPrivateCandidate(selected, beforeOrders);
} else {
  processing = await processDownloadedDocuments({ documentId: selected.document.id, limit: 1 });
  const failedResult = (processing.results || []).find(result => result.status === 'parse_error');
  if (failedResult) {
    throw new Error(`BEALLS_REPROCESS_FAILED: ${failedResult.error || 'unknown parse error'}`);
  }
}

const { recovered } = await verifyPersistedOrders();
if (!recovered) {
  throw new Error('BEALLS_RECOVERY_VALIDATION_FAILED: no persisted order row contains the certified five exact lines and quantity 340.');
}

const repairScript = path.join(API_ROOT, 'scripts', 'repair-generated-checklists.mjs');
const { stdout: repairStdout, stderr: repairStderr } = await execFileAsync(process.execPath, [
  repairScript,
  '--customer', EXPECTED.customer_code,
  '--limit', '5000',
  '--apply',
  '--replace-pending'
], {
  cwd: PROJECT_ROOT,
  env: process.env,
  maxBuffer: 64 * 1024 * 1024
});

const final = {
  ok: true,
  tool_version: TOOL_VERSION,
  backup_dir: backupDir,
  selected_source_type: selected.source_type,
  selected_document_id: selected.document?.id || null,
  selected_source_path: selected.source_path || null,
  selected_source_sha256: selected.source_sha256 || null,
  recovered_purchase_order_id: recovered.id,
  persisted_line_count: recovered.purchase_order_lines?.length || 0,
  persisted_qty: (recovered.purchase_order_lines || []).reduce((sum, line) => sum + Number(line.qty_total || 0), 0),
  processing,
  checklist_repair_stdout: repairStdout,
  checklist_repair_stderr: repairStderr,
  a2000_write_performed: false
};

await fs.writeFile(path.join(backupDir, 'recovery-result.json'), JSON.stringify(final, null, 2));
console.log(JSON.stringify(final, null, 2));
