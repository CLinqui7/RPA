import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrder, parsePurchaseOrders, parseRawPurchaseOrder } from './po/parsers/index.js';
import { allCustomerCodes, CUSTOMER_PROFILES, resolveCustomerCodeAlias } from './po/customerProfiles.js';
import { loadMasterData } from './po/enrichment/masterData.js';
import { hasBlockingA2000Conflicts, strictHeaderMissing, strictLineMissing } from './a2000/strictImport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');
const SOURCE_ROOT = path.join(API_ROOT, 'training', 'all_customer_source_fixtures');

const EXPECTED_CODES = [
  '10BELOW', 'BEALLSOUTL', 'CARNIVAL', 'CATO', 'CITI', 'COLONY', 'GABRIELBRO', 'GORBRORET',
  'HAMRICKS', 'IPC', 'ITSFASHION', 'MACYSBACKS', 'MANDEE', 'MARSHALLS', 'MESALVEINC', 'OLLIES',
  'SHOE4500', 'SPENCER', 'TILLYS', 'TJMAXX', 'VARIETYWHO', 'VERSONA', 'ZUMIEZ'
].sort();

const EXPECTED_TERMS = Object.freeze({
  '10BELOW': '6C', BEALLSOUTL: 'X6', CARNIVAL: 'C6', CATO: '6C', CITI: 'X6', COLONY: 'C3',
  GABRIELBRO: 'C7', GORBRORET: 'C6', HAMRICKS: 'C3', IPC: 'PP', ITSFASHION: 'C6', MACYSBACKS: 'C6',
  MANDEE: '3A', MARSHALLS: 'X6', MESALVEINC: '6C', OLLIES: '3A', SHOE4500: 'C3', SPENCER: 'C6',
  TILLYS: 'C6', TJMAXX: 'X6', VARIETYWHO: 'C4', VERSONA: '6C', ZUMIEZ: '6C'
});

const FIXTURES = [
  { key: 'tenbelow', rel: '10 below/72041 American Exchange PO.pdf', parser: 'tenbelow', customer: '10BELOW' },
  { key: 'itsfashion', rel: 'ITSFASHION/stainless steel AMEX PO.pdf', parser: 'catocorp', customer: 'ITSFASHION', document: { subject: 'ITS FASHION PURCHASE ORDERS' } },
  { key: 'macysbacks', rel: 'MACYSBACKS/PO 4931768.pdf', parser: 'macysbacks', customer: 'MACYSBACKS' },
  { key: 'marshalls', rel: 'MARSHALLS/hardcopie.PDF', parser: 'marshalls', customer: 'MARSHALLS' },
  { key: 'mesalve', rel: 'MESALVEINC/reportPO-24027385.pdf', parser: 'mesalve', customer: 'MESALVEINC' },
  { key: 'ollies_canonical', rel: 'OLLIES/POLINK 1.pdf', parser: 'ollies', customer: 'OLLIES' },
  { key: 'shoeshow', rel: 'SHOE4500/hardcopie.PDF', parser: 'shoeshow', customer: 'SHOE4500' },
  { key: 'tillys', rel: 'TILLYS/hardcopie.pdf', parser: 'tillys', customer: 'TILLYS' },
  { key: 'tjmaxx', rel: 'TJMAXX/60 089114.pdf', parser: 'tjmaxx', customer: 'TJMAXX' },
  { key: 'variety', rel: 'VARIETYWHO/1885387.pdf', parser: 'variety', customer: 'VARIETYWHO' },
  { key: 'versona', rel: 'Versona/615628 earlier ship.pdf', parser: 'catocorp', customer: 'VERSONA', document: { subject: 'VERSONA PO 615628' } },
  { key: 'zumiez', rel: 'ZUMIEZ/4587_476085_20260204134804 LINKIN PARK 1.pdf', parser: 'zumiez', customer: 'ZUMIEZ' },
  { key: 'bealls_new', rel: 'beallsoutl/hardcopie nueva.pdf', parser: 'bealls', customer: 'BEALLSOUTL' },
  { key: 'bealls_old', rel: 'beallsoutl/hardcopie vieja.PDF', parser: 'bealls', customer: 'BEALLSOUTL' },
  { key: 'citi', rel: 'citi/PurchaseOrder-0000199431-00-009721.pdf', parser: 'cititrends', customer: 'CITI' },
  { key: 'colony', rel: 'colony/COLONY LINKEDIN.pdf', parser: 'colony', customer: 'COLONY' },
  { key: 'gabes', rel: 'gabrielbro/VendorCopy_13003334.pdf', parser: 'gabes', customer: 'GABRIELBRO' },
  { key: 'ipc', rel: 'ipc/IPC PO-GG-6026.pdf', parser: 'ipc', customer: 'IPC' },
  { key: 'spencer', rel: 'SPENCER/spencer.PDF', parser: 'spencers', customer: 'SPENCER' }
];

function sourceText(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function allRuntimeJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...allRuntimeJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('debug-')) out.push(full);
  }
  return out;
}

async function parseFixture(fixture) {
  const filePath = path.join(SOURCE_ROOT, fixture.rel);
  const buffer = fs.readFileSync(filePath);
  const text = await extractPdfTextFromBuffer(buffer);
  const fileName = path.basename(filePath);
  const document = { file_name: fileName, file_path: filePath, ...(fixture.document || {}) };
  return parsePurchaseOrder({ text, fileName, document });
}

async function parseFixtureOrders(fixture) {
  const filePath = path.join(SOURCE_ROOT, fixture.rel);
  const buffer = fs.readFileSync(filePath);
  const text = await extractPdfTextFromBuffer(buffer);
  const fileName = path.basename(filePath);
  const document = { file_name: fileName, file_path: filePath, ...(fixture.document || {}) };
  return parsePurchaseOrders({ text, fileName, document });
}

function codes(items = []) {
  return items.map((item) => item?.code || item?.field || 'unknown');
}

function lineMissing(parsed, lineNo) {
  return parsed.needs_mapping?.lines?.find((entry) => Number(entry.line_no) === Number(lineNo))?.missing || [];
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

const manifest = JSON.parse(sourceText('api/masters/cache/manifest.json'));
const masters = loadMasterData();
const parsed = {};
for (const fixture of FIXTURES) parsed[fixture.key] = await parseFixture(fixture);
const itsfashionBatch = await parseFixtureOrders(FIXTURES.find((fixture) => fixture.key === 'itsfashion'));

const batchFixture = async (fileName, document = {}) => {
  const filePath = path.join(API_ROOT, 'training', 'parser_fixture_pdfs', fileName);
  const buffer = fs.readFileSync(filePath);
  const text = await extractPdfTextFromBuffer(buffer);
  return parsePurchaseOrder({ text, fileName, document: { file_name: fileName, ...document } });
};
const ollies952211 = await batchFixture('PO #952211.pdf');
const carnival1674444 = await batchFixture('PO_127_1674444_0_US.pdf');
const versonaFixture = FIXTURES.find((item) => item.key === 'versona');
const versonaPath = path.join(SOURCE_ROOT, versonaFixture.rel);
const versonaText = await extractPdfTextFromBuffer(fs.readFileSync(versonaPath));
const catoFamilyWithoutBannerHint = parsePurchaseOrder({
  text: versonaText,
  fileName: path.basename(versonaPath),
  document: { file_name: path.basename(versonaPath) }
});

check('master cache v8 quarantines malformed shifted Store Master CSV rows instead of trusting shifted columns', () => {
  assert.ok(Number(manifest.version) >= 8);
  assert.equal(manifest.store_csv_policy, 'reject_shifted_columns_preserve_customer_store_keys_v1');
  assert.ok(Number(manifest.counts?.malformed_store_rows || 0) > 0);
  const ollies5050 = masters.storeByCustomerStore.get('OLLIES|5050');
  assert.ok(ollies5050, 'exact official Customer+Store key OLLIES|5050 missing');
  assert.equal(ollies5050['Source Row Status'], 'malformed_unquoted_csv_columns');
  assert.equal(ollies5050['St Addr 1'], '');
  assert.equal(ollies5050.Active, '');
});

check('exactly 23 hardcopy customer profiles are registered', () => {
  assert.deepEqual(allCustomerCodes().sort(), EXPECTED_CODES);
  assert.equal(Object.keys(CUSTOMER_PROFILES).length, 23);
});

check('all 23 customer profiles resolve to official Customer Master rows with nonempty Terms', () => {
  assert.equal(masters.loaded, true, masters.error || 'masters not loaded');
  for (const [code, expectedTerm] of Object.entries(EXPECTED_TERMS)) {
    const row = masters.customerByCode.get(code);
    assert.ok(row, `${code} missing from Customer Master`);
    assert.equal(String(row.Terms || '').trim().toUpperCase(), expectedTerm, `${code} Terms mismatch`);
  }
});

check('GORDONRBO explicitly aliases to official A2000 customer GORBRORET with C6 terms', () => {
  assert.equal(resolveCustomerCodeAlias('GORDONRBO'), 'GORBRORET');
  assert.equal(String(masters.customerByCode.get('GORBRORET')?.Terms || '').trim().toUpperCase(), 'C6');
});

check('known customer metadata with an unmatched layout blocks safely instead of falling into generic parsing', () => {
  for (const code of EXPECTED_CODES) {
    const raw = parseRawPurchaseOrder({ text: 'UNVERIFIED LAYOUT WITH NO CUSTOMER FAMILY ANCHORS', fileName: 'document.pdf', document: { customer_candidate: code } });
    assert.equal(raw.parser, 'known_unsupported', `${code} did not safe-block unmatched layout`);
    assert.equal(raw.document_identity?.customer_candidate, code);
    assert.equal(raw.header?.customer_code, null);
    assert.ok((raw.conflicts || []).some((conflict) => conflict.blocking === true));
  }
});

check('Gordon original XLSX source gap is explicit and never pretends to be PDF-parsed', () => {
  const raw = parseRawPurchaseOrder({ text: '', fileName: 'JCP815002.xlsx', document: { customer_candidate: 'GORDONRBO' } });
  assert.equal(raw.parser, 'known_unsupported');
  assert.equal(raw.document_identity?.customer_candidate, 'GORBRORET');
  assert.ok(codes(raw.conflicts).includes('source_format_not_supported_xlsx'));
  assert.equal((raw.lines || []).length, 0);
});

check('runtime parsing/enrichment code has no mapping_truth or Hermanito dependency and does not read checklist/PT/packing-slip files', () => {
  const files = allRuntimeJsFiles(path.join(API_ROOT, 'src', 'po')).concat(allRuntimeJsFiles(path.join(API_ROOT, 'src', 'a2000')));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/mapping_truth|hermanito/i.test(text), false, `${path.relative(PROJECT_ROOT, file)} references forbidden historical source`);
    const suspiciousRead = /(?:readFile|readFileSync|readdir|createReadStream)[\s\S]{0,180}(?:checklist|pick.?ticket|packing.?slip|historical)/i.test(text);
    assert.equal(suspiciousRead, false, `${path.relative(PROJECT_ROOT, file)} appears to read forbidden operational history`);
  }
});

check('all 19 canonical source PDFs route to their expected customer-specific parser and official customer', () => {
  for (const fixture of FIXTURES) {
    const item = parsed[fixture.key];
    assert.equal(item.parser, fixture.parser, `${fixture.rel} parser mismatch`);
    assert.notEqual(item.parser, 'generic', `${fixture.rel} fell into generic parser`);
    assert.equal(item.header?.customer_code, fixture.customer, `${fixture.rel} customer mismatch`);
  }
});

check('every canonical source marked parsed satisfies strict header and every line satisfies strict A2000 line requirements', () => {
  for (const fixture of FIXTURES) {
    const item = parsed[fixture.key];
    if (item.status !== 'parsed') continue;
    assert.deepEqual(strictHeaderMissing(item.header || {}), [], `${fixture.rel} parsed with incomplete header`);
    assert.equal(hasBlockingA2000Conflicts(item), false, `${fixture.rel} parsed with blocking conflicts`);
    assert.ok((item.lines || []).length > 0, `${fixture.rel} parsed without lines`);
    for (const line of item.lines || []) assert.deepEqual(strictLineMissing(item.header || {}, line), [], `${fixture.rel} line ${line.line_no} incomplete`);
  }
});

check('10BELOW applies the exact official RT scale ratio only after the printed 6 to 11 range matches VR_SKU_Z', () => {
  const item = parsed.tenbelow;
  assert.equal(item.header.store_code, 'SIMPLY10');
  assert.equal(item.header.raw?.store_master?.source, 'stores_master_exact_ship_to_address');
  assert.equal(item.status, 'parsed');
  assert.deepEqual(
    item.lines.map((line) => Array.from({ length: 8 }, (_, i) => Number(line[`qty_sz${i + 1}`] || 0))),
    [
      [20, 20, 20, 40, 40, 40, 40, 20],
      [25, 25, 25, 50, 50, 50, 50, 25]
    ]
  );
  assert.ok(item.lines.every((line) => line.raw?.qty_bucket_resolution?.source === 'VR_SKU_Z'));
});

check('Cato Corporation family does not infer CATO/ITSFASHION/VERSONA banner from legal entity alone', () => {
  assert.equal(catoFamilyWithoutBannerHint.parser, 'catocorp');
  assert.equal(catoFamilyWithoutBannerHint.header.customer_code, null);
  assert.ok(codes(catoFamilyWithoutBannerHint.conflicts).includes('cato_banner_identity_ambiguous'));
});

check('legacy single-order API blocks ITSFASHION multi-PO source instead of merging six purchase orders into one InternalOrder', () => {
  const item = parsed.itsfashion;
  assert.equal(item.header.order_no, null);
  assert.equal((item.lines || []).length, 0);
  assert.ok(codes(item.conflicts).includes('multi_order_document_requires_split'));
});

check('batch parser splits ITSFASHION multi-PO source into six independent parsed InternalOrder candidates', () => {
  assert.deepEqual(itsfashionBatch.map((item) => item.header.order_no), ['616994', '616996', '616999', '617005', '617011', '617012']);
  assert.ok(itsfashionBatch.every((item) => item.status === 'parsed'));
  assert.ok(itsfashionBatch.every((item) => item.header.customer_code === 'ITSFASHION' && item.lines.length === 1));
});

check('MACYSBACKS uses Route/Start Ship as start date and In DC By as cancel date while keeping absent order date unresolved', () => {
  const item = parsed.macysbacks;
  assert.equal(item.header.order_date, null);
  assert.equal(item.header.start_date, '2026-03-16');
  assert.equal(item.header.cancel_date, '2026-03-30');
  assert.ok(item.needs_mapping.header.includes('order_date'));
  assert.equal(item.needs_mapping.header.includes('cancel_date'), false);
});

check('MARSHALLS routing instructions do not invent sales price or size ratio', () => {
  const item = parsed.marshalls;
  assert.ok((item.lines || []).length > 0);
  for (const line of item.lines || []) {
    const missing = strictLineMissing(item.header, line);
    assert.ok(missing.includes('sales_price'));
    assert.ok(missing.includes('qty_szn'));
  }
  assert.ok(codes(item.warnings).includes('routing_document_missing_sales_order_fields'));
});

check('MESALVE exact ship-to and official masters produce a fully parsed order', () => {
  assert.equal(parsed.mesalve.status, 'parsed');
  assert.equal(parsed.mesalve.header.store_code, 'CARRETERA');
});

check('OLLIES exact printed Store/DC key survives malformed Store Master text columns while shifted columns remain quarantined', () => {
  assert.equal(parsed.ollies_canonical.header.store_code, '5100');
  assert.ok(codes(parsed.ollies_canonical.warnings).includes('printed_store_master_activity_unknown'));
  assert.equal(ollies952211.header.store_code, '5050');
  assert.ok(codes(ollies952211.warnings).includes('printed_store_master_activity_unknown'));
  assert.equal(ollies952211.status, 'parsed');
  assert.equal(ollies952211.lines[2].style_raw, 'PL17977NL-42');
  assert.equal(ollies952211.lines[2].style_code, 'PL1977NL-42');
  assert.equal(ollies952211.lines[2].color_code, '861');
  assert.equal(ollies952211.lines[2].raw?.upc_resolution?.source, 'VR_UPC_STYLE_EXACT_UPC');
  assert.ok(ollies952211.lines[2].raw?.style_master_override);
});

check('SHOE4500 and TILLYS use explicit parser default store when source lacks a text-extracted Ship To; TJMAXX remains review-only', () => {
  assert.equal(parsed.shoeshow.header.store_code, 'SAME');
  assert.equal(parsed.tillys.header.store_code, 'SAME');
  assert.equal(parsed.tjmaxx.header.store_code, null);
  assert.ok(codes(parsed.tjmaxx.warnings).includes('routing_instructions_required_for_destination'));
  assert.ok(codes(parsed.tjmaxx.conflicts).includes('order_no_requires_business_review'));
});

check('VARIETYWHO resolves truncated printed color suffix only through a unique official color-code prefix and builds official UPCs', () => {
  const item = parsed.variety;
  assert.equal(item.header.store_code, '9002');
  assert.equal(item.header.terms_code, 'C4');
  assert.equal(item.status, 'parsed');
  assert.equal(item.lines.length, 9);
  assert.equal(item.lines.some((line) => line.color_code === '07'), false);
  assert.ok(item.lines.every((line) => line.style_code && line.color_code && line.master_upc));
  assert.equal(item.lines[1].style_code, 'W7EH00184-42');
  assert.equal(item.lines[1].color_code, '078');
  assert.equal(item.lines[1].master_upc, '196540928345');
  assert.equal(item.lines[1].raw?.trailing_style_suffix_color_resolution?.reason, 'printed_suffix_unique_prefix_of_official_color');
  assert.ok(codes(item.warnings).includes('terms_master_policy_precedence'));
});

check('VERSONA preserves confirmed printed PO 615628 and removes only the obsolete PO ownership blocker', () => {
  const item = parsed.versona;
  assert.equal(item.header.customer_code, 'VERSONA');
  assert.equal(item.header.order_no, '615628');
  assert.equal(item.header.terms_code, '6C');
  assert.ok(codes(item.warnings).includes('terms_master_policy_precedence'));
  assert.ok(codes(item.warnings).includes('versona_printed_po_615628_accepted'));
  assert.equal(codes(item.conflicts).includes('order_no_requires_business_review'), false);
  assert.equal(hasBlockingA2000Conflicts(item), false);
  assert.equal(item.status, 'parsed');
  assert.ok((item.lines || []).every((line) => line.style_code && line.color_code && line.master_upc));
});

check('ZUMIEZ, BEALLS new and CITI canonical sources are fully parsed using PDF plus official masters only', () => {
  assert.equal(parsed.zumiez.status, 'parsed');
  assert.equal(parsed.bealls_new.status, 'parsed');
  assert.equal(parsed.citi.status, 'parsed');
});

check('BEALLS old legacy style resolves by unique nearest official prefix extension, printed White plus exact size, and official UPC', () => {
  const item = parsed.bealls_old;
  assert.equal(item.status, 'parsed');
  assert.equal(item.header.division_code, 'MJ');
  assert.equal(item.header.warehouse_code, 'PE');
  assert.equal(item.lines.length, 6);
  const expectedUpcs = ['199347273304', '199347273311', '199347273328', '199347273274', '199347273281', '199347273298'];
  item.lines.forEach((line, index) => {
    assert.equal(line.style_code, '03HOSTARYK');
    assert.equal(line.color_code, '001');
    assert.equal(line.master_upc, expectedUpcs[index]);
    assert.equal(line.raw?.style_similarity_resolution?.reason, 'nearest_official_style_unique_prefix_extension');
    assert.equal(line.raw?.color_resolution?.reason, 'printed_color_semantic_disambiguated_by_exact_official_size');
    assert.deepEqual(strictLineMissing(item.header, line), []);
  });
});

check('COLONY keeps absent ship/cancel dates unresolved and records source contact typo without deriving order fields from it', () => {
  const item = parsed.colony;
  assert.equal(item.header.start_date, null);
  assert.equal(item.header.cancel_date, null);
  assert.ok(codes(item.warnings).includes('source_email_typo'));
});

check('GABRIELBRO applies official GK scale ratio only when printed CS PK 12 exactly matches the official ratio total 12', () => {
  const item = parsed.gabes;
  assert.equal(item.header.store_code, 'SAME');
  assert.equal(item.header.warehouse_code, 'PE');
  assert.equal(item.status, 'parsed');
  assert.equal(item.lines.length, 2);
  assert.deepEqual(item.lines.map((line) => [line.style_code, line.color_code, line.master_upc]), [
    ['WELMA61K', 'MDA', '194866098261'],
    ['WELMA61K', 'FSA', '194866098254']
  ]);
  assert.deepEqual(
    item.lines.map((line) => Array.from({ length: 8 }, (_, i) => Number(line[`qty_sz${i + 1}`] || 0))),
    [
      [42, 42, 42, 42, 84, 84, 84, 84],
      [55, 55, 55, 55, 110, 110, 110, 110]
    ]
  );
  assert.ok(item.lines.every((line) => line.raw?.case_pack_master_ratio_resolution?.status === 'applied'));
});

check('IPC corrects only the same-MM/DD one-year source typo to 2026, preserves raw dates, and still requires a cancel date', () => {
  const item = parsed.ipc;
  assert.equal(codes(item.conflicts).includes('source_date_conflict'), false);
  assert.ok(codes(item.warnings).includes('source_date_year_typo_corrected'));
  assert.ok(codes(item.warnings).includes('terms_master_policy_precedence'));
  assert.equal(item.header.start_date, '2026-05-08');
  assert.equal(item.header.cancel_date, null);
  assert.equal(item.header.raw?.pickup_date_resolution?.corrected_start_date, '2026-05-08');
  assert.equal(item.header.terms_code, 'PP');
  assert.equal(item.lines[0].style_code, 'AX9851B-42');
  assert.equal(item.lines[0].color_code, 'G16');
  assert.equal(item.lines[0].master_upc, '196540921803');
  assert.equal(item.lines[0].qty_sz1, 2000);
  assert.equal(item.needs_mapping.header.includes('cancel_date'), true);
});


check('SPENCER uploaded hardcopy resolves exact UPC, master style/color, ship-to store and EACH size bucket', () => {
  const item = parsed.spencer;
  assert.equal(item.header.customer_code, 'SPENCER');
  assert.equal(item.header.order_no, '305696');
  assert.equal(item.header.store_code, '10018');
  assert.equal(item.header.terms_code, 'C6');
  assert.equal(item.status, 'parsed');
  assert.equal(item.lines.length, 1);
  assert.equal(item.lines[0].style_code, 'AXG2404-42');
  assert.equal(item.lines[0].color_code, '003');
  assert.equal(item.lines[0].customer_upc, '196540785962');
  assert.equal(item.lines[0].qty_sz1, 1008);
});

check('Batch01 Carnival converts CASE count by printed pack 6, maps exact printed size to VR_SKU_Z SIZE_NUM, and blocks EACH price until a source rule exists', () => {
  const item = carnival1674444;
  assert.equal(item.header.customer_code, 'CARNIVAL');
  assert.ok((item.lines || []).every((line) => line.style_code === '133CARNIVA01'));
  assert.ok((item.lines || []).every((line) => line.color_code === '003'));
  assert.deepEqual(item.lines.map((line) => line.qty_total), [408, 372, 354, 366, 324, 312, 270]);
  item.lines.forEach((line, index) => {
    assert.equal(Number(line[`qty_sz${index + 1}`]), line.qty_total);
    assert.equal(strictLineMissing(item.header, line).includes('qty_szn'), false);
    assert.equal(strictLineMissing(item.header, line).includes('sales_price'), true);
    assert.equal(line.sales_price, null);
    assert.equal(line.raw?.case_to_each_conversion?.exact_each_price_candidate, 5.985);
  });
  assert.ok(codes(item.conflicts).includes('carnival_each_sales_price_requires_source_rule'));
});

const failed = checks.filter((item) => item.result === 'FAIL');
console.log(JSON.stringify({
  suite: 'ALL_CUSTOMERS_MASTER_ONLY_HARDENED_GUARDS',
  customer_profiles: EXPECTED_CODES.length,
  canonical_source_pdfs: FIXTURES.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks
}, null, 2));

if (failed.length) process.exitCode = 1;
