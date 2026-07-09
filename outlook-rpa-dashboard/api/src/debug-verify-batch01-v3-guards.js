import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrder } from './po/parsers/index.js';
import { parseOllies } from './po/parsers/ollies.js';
import { parseTenBelow } from './po/parsers/tenbelow.js';
import { enrichOrderWithMasters } from './po/enrichment/enrichOrder.js';
import { hasExplicitA2000QtyBucket, hasPositiveA2000QtyBucket, invalidA2000QtyBuckets, strictLineMissing } from './a2000/strictImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

async function parseFixture(fileName) {
  const filePath = path.join(API_ROOT, 'training', 'parser_fixture_pdfs', fileName);
  const buffer = fs.readFileSync(filePath);
  const text = await extractPdfTextFromBuffer(buffer);
  return parsePurchaseOrder({ text, fileName, document: { file_name: fileName, file_path: filePath } });
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, result: 'PASS' });
  } catch (error) {
    checks.push({ name, result: 'FAIL', error: error.message });
  }
}

const manifest = JSON.parse(readText('api/masters/cache/manifest.json'));
check('master cache is v8 official_masters_only with hardened store CSV policy', () => {
  assert.ok(Number(manifest.version) >= 8);
  assert.equal(manifest.source_policy, 'official_masters_only');
  assert.equal(manifest.customer_profile_policy, 'master_only_all_customers_v1');
  assert.equal(manifest.store_csv_policy, 'reject_shifted_columns_preserve_customer_store_keys_v1');
});

check('runtime training mapping_truth is absent', () => {
  assert.equal(fs.existsSync(path.join(API_ROOT, 'training', 'mapping_truth')), false);
});

const olliesParser = readText('api/src/po/parsers/ollies.js');
const carnivalParser = readText('api/src/po/parsers/carnival.js');
const tenbelowParser = readText('api/src/po/parsers/tenbelow.js');
const enrichment = readText('api/src/po/enrichment/enrichOrder.js');
const exportBatch = readText('api/src/a2000/exportBatch.js');
const server = readText('api/src/server.js');

check('batch parsers have no checklist/PT/historical runtime dependency', () => {
  const source = [olliesParser, carnivalParser, tenbelowParser].join('\n');
  assert.equal(/mapping_truth|historical\.json|readFileSync\([^)]*(checklist|pick.?ticket|packing.?slip)/i.test(source), false);
});

check('exact UPC resolver never uses ticket_sku', () => {
  const match = enrichment.match(/function resolveExactUpc\([\s\S]+?\n}\n\nfunction resolveCompositeStyleSuffix/);
  assert.ok(match, 'resolveExactUpc block not found');
  assert.equal(match[0].includes('line.ticket_sku'), false);
});

check('composite style-color resolution is explicit-source-semantic scoped', () => {
  assert.ok(enrichment.includes("upper(raw.composite_style_color_semantics) === 'STYLE_COLOR_SUFFIX'"));
  assert.ok(tenbelowParser.includes("composite_style_color_semantics: 'STYLE_COLOR_SUFFIX'"));
});

check('old PDF-vs-master terms conflict heuristic is removed', () => {
  assert.equal(enrichment.includes('Terms raw is present but could not be confidently compared'), false);
  assert.ok(enrichment.includes("source: 'customer_master'"));
});

check('unsafe qty_total to QTY_SZ1 export fallbacks are removed', () => {
  const source = `${exportBatch}\n${server}`;
  assert.equal(source.includes('qty_sz1 ?? line.quantity ?? line.qty_total'), false);
  assert.equal(source.includes('qty_sz1 ?? line.qty_total'), false);
});

check('unsafe export defaults X/PE/Y are removed', () => {
  const source = `${exportBatch}\n${server}`;
  assert.equal(/division_code\s*\|\|\s*['"]X['"]/.test(source), false);
  assert.equal(/warehouse_code\s*\|\|\s*['"]PE['"]/.test(source), false);
  assert.equal(/master_invoice\s*\|\|\s*['"]Y['"]/.test(source), false);
});

check('server uses csv.js as A2000 column source of truth', () => {
  assert.ok(server.includes("from './a2000/csv.js'"));
  assert.equal(server.includes('const A2000_HEADER_COLUMNS = ['), false);
  assert.equal(server.includes('const A2000_LINE_COLUMNS = ['), false);
});

check('aggressive server-side Citi finalizer is removed', () => {
  assert.equal(server.includes('finalizeLabParsed'), false);
  assert.equal(server.includes('citi_first_master_candidate'), false);
  assert.equal(server.includes('citi_first_valid_master_candidate'), false);
});

check('raw identity fields do not use customer-name fallbacks', () => {
  const ollies = parseOllies({ text: 'PO#: 12345 UPC Number Model#' });
  const tenbelow = parseTenBelow({ text: 'PURCHASE # 12345 VENDOR STYLE TOTAL UNITS' });
  assert.equal(ollies.document_identity.legal_entity_raw, null);
  assert.equal(ollies.document_identity.brand_raw, null);
  assert.equal(tenbelow.document_identity.legal_entity_raw, null);
  assert.equal(tenbelow.document_identity.brand_raw, null);
});

const tenbelow = await parseFixture('72041 American Exchange PO.pdf');
check('10BELOW TERM_NO comes from Customer Master as 6C', () => {
  assert.equal(tenbelow.header.terms_raw, '3% / 60 DAYS');
  assert.equal(tenbelow.header.terms_code, '6C');
  assert.equal(tenbelow.conflicts.some(conflict => conflict.field === 'terms_code'), false);
  assert.equal(tenbelow.header.raw?.customer_master?.terms_resolution?.source, 'customer_master');
});

check('quality gate accepts any positive QTY_SZn bucket, not only QTY_SZ1', () => {
  assert.equal(hasExplicitA2000QtyBucket({ qty_sz4: 96 }), true);
  assert.equal(hasPositiveA2000QtyBucket({ qty_sz4: 96 }), true);
  assert.equal(hasExplicitA2000QtyBucket({ qty_total: 96 }), false);
  assert.equal(strictLineMissing({ warehouse_code: 'PE' }, { line_no: 1, style_code: 'X', color_code: '001', sales_price: 1, qty_sz4: 96 }).includes('qty_szn'), false);
  assert.equal(strictLineMissing({ warehouse_code: 'PE' }, { line_no: 1, style_code: 'X', color_code: '001', sales_price: 1, qty_total: 96 }).includes('qty_szn'), true);
});

check('zero, negative and nonnumeric QTY_SZn cannot make a line importable', () => {
  assert.equal(hasPositiveA2000QtyBucket({ qty_sz1: 0 }), false);
  assert.equal(hasPositiveA2000QtyBucket({ qty_sz2: -1 }), false);
  assert.equal(hasPositiveA2000QtyBucket({ qty_sz3: 'ABC' }), false);
  assert.equal(invalidA2000QtyBuckets({ qty_sz2: -1 }).length, 1);
  assert.equal(invalidA2000QtyBuckets({ qty_sz3: 'ABC' }).length, 1);
  assert.ok(strictLineMissing({ warehouse_code: 'PE' }, { line_no: 1, style_code: 'X', color_code: '001', sales_price: 1, qty_sz1: 0 }).includes('qty_szn'));
  assert.ok(strictLineMissing({ warehouse_code: 'PE' }, { line_no: 1, style_code: 'X', color_code: '001', sales_price: 1, qty_sz2: -1 }).includes('qty_szn_invalid'));
});

const ollies = await parseFixture('PO #952211.pdf');
check('OLLIES exact printed UPC resolves master style/color and explicit bucket', () => {
  const line = ollies.lines[0];
  assert.equal(line.customer_upc, '199347506785');
  assert.equal(line.style_code, 'PL1975NL-42');
  assert.equal(line.color_code, '176');
  assert.equal(line.qty_sz1, 4896);
  assert.equal(line.raw?.upc_resolution?.source, 'VR_UPC_STYLE_EXACT_UPC');
  assert.equal(line.raw?.qty_bucket_resolution?.quantity_semantics, 'EACH');
});

const caseQuantitySynthetic = enrichOrderWithMasters({
  parser: 'ollies',
  header: { customer_raw: "OLLIE'S BARGAIN OUTLET, INC.", customer_code: null, terms_code: null, raw: {} },
  lines: [{
    line_no: 1,
    customer_upc: '199347506785',
    upc: '199347506785',
    style_raw: 'PL1975NL-42',
    qty_total: 68,
    sales_price: 35.91,
    raw: { upc_semantics: 'UPC', quantity_semantics: 'CASE' }
  }],
  conflicts: []
});
check('CASE quantity never auto-populates QTY_SZn from qty_total', () => {
  const line = caseQuantitySynthetic.lines[0];
  assert.equal(line.style_code, 'PL1975NL-42');
  assert.equal(line.color_code, '176');
  assert.equal(hasExplicitA2000QtyBucket(line), false);
  assert.equal(line.raw?.qty_bucket_resolution?.status, 'not_applied');
  assert.ok(['quantity_semantics_not_each', 'quantity_semantics_or_quantity_not_safe'].includes(line.raw?.qty_bucket_resolution?.reason));
});

const ticketSkuSynthetic = enrichOrderWithMasters({
  parser: 'shoeshow',
  header: { customer_raw: 'THE SHOE SHOW', raw: {} },
  lines: [{ line_no: 1, ticket_sku: '199347506785', style_raw: 'ZZ_NOT_A_STYLE', qty_total: 1, sales_price: 1, raw: {} }],
  conflicts: []
});
check('numeric ticket SKU cannot trigger exact UPC reverse lookup', () => {
  assert.equal(ticketSkuSynthetic.lines[0].raw?.upc_resolution, undefined);
});

check('generic ticket SKU is never relabeled as customer_upc', () => {
  assert.equal(ticketSkuSynthetic.lines[0].customer_upc || null, null);
});

check('A2000 export does not repurpose master size name or raw customer identifiers into optional fields', () => {
  const source = `${exportBatch}\n${server}`;
  assert.equal(source.includes('row.SIZE_NO = clean(line.size_code)'), false);
  assert.equal(source.includes('row.SIZE_NO = cleanExportValue(line.size_code)'), false);
  assert.equal(source.includes('row.CUST_STYLE1 = trimExport(line.customer_sku'), false);
  assert.equal(source.includes('row.CUST_STYLE2 = trimExport(line.customer_upc'), false);
  assert.equal(source.includes('row.REF = trimExport(line.customer_upc'), false);
  assert.ok(exportBatch.includes('row.SIZE_NO = clean(line.a2000_size_no)'));
  assert.ok(server.includes('row.SIZE_NO = cleanExportValue(line.a2000_size_no)'));
});

const genericCompositeSynthetic = enrichOrderWithMasters({
  parser: 'generic',
  header: { customer_code: '10BELOW', raw: {} },
  lines: [{ line_no: 1, style_raw: 'WILLA01L-SGA', qty_total: 1, sales_price: 1, raw: {} }],
  conflicts: []
});
check('composite style suffix rule cannot leak to other parsers', () => {
  assert.equal(genericCompositeSynthetic.lines[0].raw?.composite_style_resolution, undefined);
});

const failed = checks.filter(item => item.result === 'FAIL');
console.log(JSON.stringify({
  suite: 'BATCH01_V3_MASTER_ONLY_GUARDS',
  passed: checks.length - failed.length,
  failed: failed.length,
  checks
}, null, 2));

if (failed.length) process.exitCode = 1;
