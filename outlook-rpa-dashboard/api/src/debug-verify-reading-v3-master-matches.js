import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrder, parsePurchaseOrders } from './po/parsers/index.js';
import { strictLineMissing } from './a2000/strictImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(API_ROOT, 'training', 'all_customer_source_fixtures');
const BATCH_ROOT = path.join(API_ROOT, 'training', 'parser_fixture_pdfs');

async function parseSource(relativePath, document = {}) {
  const filePath = path.join(SOURCE_ROOT, relativePath);
  const text = await extractPdfTextFromBuffer(await fs.readFile(filePath));
  return parsePurchaseOrder({ text, fileName: path.basename(filePath), document: { file_name: path.basename(filePath), file_path: filePath, ...document } });
}

async function parseSourceOrders(relativePath, document = {}) {
  const filePath = path.join(SOURCE_ROOT, relativePath);
  const text = await extractPdfTextFromBuffer(await fs.readFile(filePath));
  return parsePurchaseOrders({ text, fileName: path.basename(filePath), document: { file_name: path.basename(filePath), file_path: filePath, ...document } });
}

async function parseBatch(fileName, document = {}) {
  const filePath = path.join(BATCH_ROOT, fileName);
  const text = await extractPdfTextFromBuffer(await fs.readFile(filePath));
  return parsePurchaseOrder({ text, fileName, document: { file_name: fileName, ...document } });
}

function codes(items = []) {
  return items.map((item) => item?.code || item?.field || 'unknown');
}

function positiveBuckets(line = {}) {
  const buckets = {};
  for (let index = 1; index <= 18; index += 1) {
    const key = `qty_sz${index}`;
    if (Number(line[key]) > 0) buckets[key] = Number(line[key]);
  }
  return buckets;
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

const tenbelow = await parseSource('10 below/72041 American Exchange PO.pdf', { subject: '10BELOW' });
const variety = await parseSource('VARIETYWHO/1885387.pdf', { subject: 'VARIETYWHO' });
const beallsOld = await parseSource('beallsoutl/hardcopie vieja.PDF', { subject: 'BEALLSOUTL' });
const gabes = await parseSource('gabrielbro/VendorCopy_13003334.pdf', { subject: 'GABRIELBRO' });
const ipc = await parseSource('ipc/IPC PO-GG-6026.pdf', { subject: 'IPC' });
const mesalve = await parseSource('MESALVEINC/reportPO-24027385.pdf', { subject: 'MESALVEINC' });
const citi = await parseSource('citi/PurchaseOrder-0000199431-00-009721.pdf', { subject: 'CITI' });
const marshalls = await parseSource('MARSHALLS/hardcopie.PDF', { subject: 'MARSHALLS' });
const shoeshow = await parseSource('SHOE4500/hardcopie.PDF', { subject: 'SHOE4500' });
const tjmaxx = await parseSource('TJMAXX/60 089114.pdf', { subject: 'TJMAXX' });
const versona = await parseSource('Versona/615628 earlier ship.pdf', { subject: 'VERSONA PO 615628' });
const itsfashionOrders = await parseSourceOrders('ITSFASHION/stainless steel AMEX PO.pdf', { subject: 'ITS FASHION PURCHASE ORDERS' });
const carnival = await parseBatch('PO_127_1674444_0_US.pdf', { subject: 'CARNIVAL' });

check('10BELOW chooses SIMPLY10 from the printed primary Ship To name/address and builds official UPCs without inventing size buckets', () => {
  assert.equal(tenbelow.header.store_code, 'SIMPLY10');
  assert.equal(tenbelow.header.raw?.store_master?.source, 'stores_master_exact_ship_to_address');
  assert.deepEqual(tenbelow.lines.map((line) => [line.style_code, line.color_code, line.master_upc]), [
    ['WILLA01L', 'SGA', '194866934613'],
    ['RYNN05L', 'WHA', '194866886837']
  ]);
  assert.ok(tenbelow.lines.every((line) => Object.keys(positiveBuckets(line)).length === 0));
});

check('VARIETYWHO matches every printed base style and truncated color hint to official master style/color and unique UPC', () => {
  assert.equal(variety.status, 'parsed');
  assert.equal(variety.header.terms_code, 'C4');
  assert.equal(variety.lines.length, 9);
  assert.ok(variety.lines.every((line) => line.style_code && line.color_code && line.master_upc));
  const line2 = variety.lines[1];
  assert.equal(line2.style_raw, 'W7EH00184-42-07');
  assert.equal(line2.style_code, 'W7EH00184-42');
  assert.equal(line2.color_code, '078');
  assert.equal(line2.master_upc, '196540928345');
  assert.equal(line2.raw?.trailing_style_suffix_color_resolution?.reason, 'printed_suffix_unique_prefix_of_official_color');
});

check('BEALLS old resolves 03HOSTAR-Y only because 03HOSTARYK is the unique nearest prefix extension, then exact White+size picks 001 and the correct UPC/bucket', () => {
  assert.equal(beallsOld.status, 'parsed');
  const expected = [
    ['1', '199347273304', 'qty_sz5', 46],
    ['2', '199347273311', 'qty_sz6', 46],
    ['3', '199347273328', 'qty_sz7', 46],
    ['11', '199347273274', 'qty_sz2', 92],
    ['12', '199347273281', 'qty_sz3', 92],
    ['13', '199347273298', 'qty_sz4', 92]
  ];
  beallsOld.lines.forEach((line, index) => {
    const [size, upc, bucket, qty] = expected[index];
    assert.equal(line.size_raw, size);
    assert.equal(line.style_code, '03HOSTARYK');
    assert.equal(line.color_code, '001');
    assert.equal(line.master_upc, upc);
    assert.equal(line[bucket], qty);
    assert.equal(line.raw?.style_similarity_resolution?.reason, 'nearest_official_style_unique_prefix_extension');
    assert.equal(line.raw?.color_resolution?.reason, 'printed_color_semantic_disambiguated_by_exact_official_size');
  });
});

check('GABRIELBRO matches MRMD MLTI to MERMAID MULTI/MDA and FSCHA to FUCHSIA-FUSCHIA/FSA using official prepack ALL-size master rows', () => {
  assert.equal(gabes.header.store_code, 'SAME');
  assert.equal(gabes.header.warehouse_code, 'PE');
  assert.deepEqual(gabes.lines.map((line) => [line.style_code, line.color_code, line.master_upc]), [
    ['WELMA61K', 'MDA', '194866098261'],
    ['WELMA61K', 'FSA', '194866098254']
  ]);
  assert.ok(gabes.lines.every((line) => line.raw?.description_color_resolution?.reason === 'unique_alpha_all_size_official_color_for_prepack'));
  assert.ok(gabes.lines.every((line) => strictLineMissing(gabes.header, line).includes('qty_szn')));
});

check('IPC splits AX9851B-42-G16 into official style/color, builds UPC, maps ordered QTY to the unique PC bucket, and keeps PP terms', () => {
  const line = ipc.lines[0];
  assert.equal(ipc.header.terms_code, 'PP');
  assert.equal(line.style_code, 'AX9851B-42');
  assert.equal(line.color_code, 'G16');
  assert.equal(line.master_upc, '196540921803');
  assert.equal(line.qty_sz1, 2000);
  assert.ok(codes(ipc.conflicts).includes('source_date_conflict'));
});

check('MESALVE SOLID lines use printed description color words to select official numeric colors and UPCs', () => {
  assert.equal(mesalve.lines[0].color_code, '033');
  assert.equal(mesalve.lines[0].master_upc, '199347468618');
  assert.equal(mesalve.lines[0].raw?.description_color_resolution?.semantic_key, 'RED');
  assert.equal(mesalve.lines[1].color_code, '006');
  assert.equal(mesalve.lines[1].master_upc, '199347468625');
  assert.equal(mesalve.lines[1].raw?.description_color_resolution?.semantic_key, 'BROWN');
});

check('ITSFASHION six hardcopies inside one PDF split into six independent parsed orders with style/color/UPC/buckets from official masters', () => {
  assert.deepEqual(itsfashionOrders.map((item) => item.header.order_no), ['616994', '616996', '616999', '617005', '617011', '617012']);
  assert.equal(itsfashionOrders.length, 6);
  for (const [index, item] of itsfashionOrders.entries()) {
    assert.equal(item.header.customer_code, 'ITSFASHION');
    assert.equal(item.header.store_code, 'SHIPTO');
    assert.equal(item.header.terms_code, 'C6');
    assert.equal(item.status, 'parsed', `order ${item.header.order_no} not parsed`);
    assert.equal(item.header.raw?.source_order_index, index + 1);
    assert.equal(item.header.raw?.source_order_count, 6);
    assert.equal(item.lines.length, 1);
    assert.ok(item.lines[0].style_code);
    assert.ok(item.lines[0].color_code);
    assert.ok(item.lines[0].master_upc);
    assert.equal(item.lines[0].qty_sz1, 160);
    assert.equal(codes(item.conflicts).includes('multi_order_document_requires_split'), false);
  }
  const corrected = itsfashionOrders.find((item) => item.header.order_no === '617005')?.lines?.[0];
  assert.equal(corrected?.style_raw, 'SNNT0010C-A27');
  assert.equal(corrected?.style_code, 'SNNST0010C');
  assert.equal(corrected?.color_code, 'A27');
  assert.equal(corrected?.master_upc, '199347376630');
});

check('CITI preserves printed customer UPC separately while official style/color builds master UPC and does not need Reference PO', () => {
  const line = citi.lines[0];
  assert.equal(citi.header.order_no, '0000199431');
  assert.equal(citi.header.raw?.reference_po, null);
  assert.equal(line.customer_upc, '400433438706');
  assert.equal(line.style_raw, 'AX4028H-42-LR1');
  assert.equal(line.style_code, 'AX4028H-42');
  assert.equal(line.color_code, 'LR1');
  assert.equal(line.master_upc, '196540051104');
  assert.ok(line.raw?.upc_note);
});

check('CARNIVAL BLACK source resolves official 133CARNIVA01/003 and per-size official UPCs but CASE counts never become QTY buckets', () => {
  assert.ok(carnival.lines.every((line) => line.style_code === '133CARNIVA01'));
  assert.ok(carnival.lines.every((line) => line.color_code === '003'));
  assert.ok(carnival.lines.every((line) => line.master_upc));
  assert.ok(carnival.lines.every((line) => Object.keys(positiveBuckets(line)).length === 0));
});

check('SHOE4500 resolves every printed size-grid row to its own official master UPC without pretending the multi-size line has one UPC', () => {
  const line = shoeshow.lines[0];
  assert.equal(shoeshow.status, 'parsed');
  assert.equal(line.style_code, 'HAMPTON');
  assert.equal(line.color_code, 'TSI');
  assert.equal(line.master_upc ?? null, null);
  assert.deepEqual((line.master_upcs_by_size || []).map((item) => [item.size_raw, item.upc, item.qty_raw]), [
    ['8', '199347310061', 346],
    ['9', '199347310078', 520],
    ['10', '199347310085', 580],
    ['11', '199347310092', 580],
    ['12', '199347310108', 460],
    ['13', '199347310115', 322]
  ]);
  assert.equal(line.raw?.upc_master_by_size?.reason, 'all_printed_sizes_unique_master_upc');
});

check('MARSHALLS style/color pairs are official-master resolved, but a single UPC cannot be built without size and priced/routing companion data still blocks the lines', () => {
  assert.equal(marshalls.header.order_no, '314654');
  assert.ok(marshalls.lines.every((line) => line.style_code && line.color_code));
  assert.ok(marshalls.lines.every((line) => !line.master_upc));
  assert.ok(marshalls.lines.every((line) => (line.raw?.upc_master_candidates || []).length === 6));
  assert.ok(marshalls.lines.every((line) => strictLineMissing(marshalls.header, line).includes('sales_price')));
  assert.ok(marshalls.lines.every((line) => strictLineMissing(marshalls.header, line).includes('qty_szn')));
});

const serverSource = await fs.readFile(path.join(API_ROOT, 'src', 'server.js'), 'utf8');
check('server production PDF paths use parsePurchaseOrders so a multi-PO ITSFASHION PDF is flattened into independent orders', () => {
  assert.match(serverSource, /import\s+\{\s*parsePurchaseOrders\s*\}\s+from\s+'\.\/po\/parsers\/index\.js'/);
  assert.ok((serverSource.match(/parsePurchaseOrders\(/g) || []).length >= 4);
  assert.doesNotMatch(serverSource, /import\s+\{[^}]*parsePurchaseOrder[^s][^}]*\}/);
});

check('TJMAXX and VERSONA keep printed PO values as evidence but block final A2000 export until business PO ownership review', () => {
  assert.ok(codes(tjmaxx.conflicts).includes('order_no_requires_business_review'));
  assert.ok(codes(versona.conflicts).includes('order_no_requires_business_review'));
  assert.equal(tjmaxx.status, 'needs_mapping');
  assert.equal(versona.status, 'needs_mapping');
  assert.ok(versona.lines.every((line) => line.style_code && line.color_code && line.master_upc));
});

const failed = checks.filter((item) => item.result === 'FAIL');
console.log(JSON.stringify({
  suite: 'HARDCOPY_READING_V3_MASTER_MATCH_MULTIORDER_GUARDS',
  passed: checks.length - failed.length,
  failed: failed.length,
  checks
}, null, 2));
if (failed.length) process.exitCode = 1;
