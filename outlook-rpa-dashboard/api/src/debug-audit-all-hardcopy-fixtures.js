import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const FIXTURE_ROOT = path.join(API_ROOT, 'training', 'all_customer_source_fixtures');

const FIXTURES = [
  { rel: '10 below/72041 American Exchange PO.pdf', parser: 'tenbelow', customer: '10BELOW' },
  { rel: 'ITSFASHION/stainless steel AMEX PO.pdf', parser: 'catocorp', customer: 'ITSFASHION', document: { subject: 'ITS FASHION PURCHASE ORDERS' } },
  { rel: 'MACYSBACKS/PO 4931768.pdf', parser: 'macysbacks', customer: 'MACYSBACKS' },
  { rel: 'MARSHALLS/hardcopie.PDF', parser: 'marshalls', customer: 'MARSHALLS' },
  { rel: 'MESALVEINC/reportPO-24027385.pdf', parser: 'mesalve', customer: 'MESALVEINC' },
  { rel: 'OLLIES/POLINK 1.pdf', parser: 'ollies', customer: 'OLLIES' },
  { rel: 'SHOE4500/hardcopie.PDF', parser: 'shoeshow', customer: 'SHOE4500' },
  { rel: 'TILLYS/hardcopie.pdf', parser: 'tillys', customer: 'TILLYS' },
  { rel: 'TJMAXX/60 089114.pdf', parser: 'tjmaxx', customer: 'TJMAXX' },
  { rel: 'VARIETYWHO/1885387.pdf', parser: 'variety', customer: 'VARIETYWHO' },
  { rel: 'Versona/615628 earlier ship.pdf', parser: 'catocorp', customer: 'VERSONA', document: { subject: 'VERSONA PO 615628' } },
  { rel: 'ZUMIEZ/4587_476085_20260204134804 LINKIN PARK 1.pdf', parser: 'zumiez', customer: 'ZUMIEZ' },
  { rel: 'beallsoutl/hardcopie nueva.pdf', parser: 'bealls', customer: 'BEALLSOUTL' },
  { rel: 'beallsoutl/hardcopie vieja.PDF', parser: 'bealls', customer: 'BEALLSOUTL' },
  { rel: 'citi/PurchaseOrder-0000199431-00-009721.pdf', parser: 'cititrends', customer: 'CITI' },
  { rel: 'colony/COLONY LINKEDIN.pdf', parser: 'colony', customer: 'COLONY' },
  { rel: 'gabrielbro/VendorCopy_13003334.pdf', parser: 'gabes', customer: 'GABRIELBRO' },
  { rel: 'ipc/IPC PO-GG-6026.pdf', parser: 'ipc', customer: 'IPC' },
  { rel: 'SPENCER/spencer.PDF', parser: 'spencers', customer: 'SPENCER' }
];

function conflictCodes(parsed) {
  return (parsed.conflicts || []).map((item) => item.code || item.field || 'unknown');
}

function warningCodes(parsed) {
  return (parsed.warnings || []).map((item) => item.code || item.field || 'unknown');
}

const results = [];
let failed = 0;

for (const fixture of FIXTURES) {
  const filePath = path.join(FIXTURE_ROOT, fixture.rel);
  try {
    const buffer = await fs.readFile(filePath);
    const text = await extractPdfTextFromBuffer(buffer);
    const fileName = path.basename(filePath);
    const document = { file_name: fileName, file_path: filePath, ...(fixture.document || {}) };
    const parsedOrders = parsePurchaseOrders({ text, fileName, document });
    const parserOk = parsedOrders.length > 0 && parsedOrders.every((parsed) => parsed.parser === fixture.parser);
    const customerOk = parsedOrders.length > 0 && parsedOrders.every((parsed) => parsed.header?.customer_code === fixture.customer);
    if (!parserOk || !customerOk) failed += 1;

    const orderSummaries = parsedOrders.map((parsed, index) => ({
      source_order_index: index + 1,
      source_order_count: parsedOrders.length,
      order_no: parsed.header?.order_no || null,
      status: parsed.status || null,
      header_missing: parsed.needs_mapping?.header || [],
      line_count: (parsed.lines || []).length,
      line_missing: parsed.needs_mapping?.lines || [],
      conflict_codes: conflictCodes(parsed),
      warning_codes: warningCodes(parsed),
      totals: parsed.totals || {}
    }));

    const first = parsedOrders[0] || {};
    results.push({
      source: fixture.rel,
      expected_parser: fixture.parser,
      actual_parsers: [...new Set(parsedOrders.map((parsed) => parsed.parser))],
      expected_customer: fixture.customer,
      actual_customers: [...new Set(parsedOrders.map((parsed) => parsed.header?.customer_code || null))],
      parser_ok: parserOk,
      customer_ok: customerOk,
      source_order_count: parsedOrders.length,
      order_no: parsedOrders.length === 1 ? first.header?.order_no || null : null,
      status: parsedOrders.length === 1 ? first.status || null : 'multi_order_split',
      header_missing: parsedOrders.length === 1 ? first.needs_mapping?.header || [] : [],
      line_count: parsedOrders.reduce((sum, parsed) => sum + (parsed.lines || []).length, 0),
      line_missing: parsedOrders.length === 1 ? first.needs_mapping?.lines || [] : [],
      conflict_codes: parsedOrders.length === 1 ? conflictCodes(first) : [],
      warning_codes: parsedOrders.length === 1 ? warningCodes(first) : [],
      totals: parsedOrders.length === 1 ? first.totals || {} : { order_count: parsedOrders.length },
      orders: orderSummaries
    });
  } catch (error) {
    failed += 1;
    results.push({ source: fixture.rel, expected_parser: fixture.parser, expected_customer: fixture.customer, result: 'ERROR', error: error.message });
  }
}

console.log(JSON.stringify({
  suite: 'ALL_CUSTOMER_SOURCE_HARDCOPY_AUDIT',
  source_pdf_count: FIXTURES.length,
  parsed_order_count: results.reduce((sum, item) => sum + Number(item.source_order_count || 0), 0),
  passed_identity_checks: FIXTURES.length - failed,
  failed_identity_checks: failed,
  results
}, null, 2));

if (failed) process.exitCode = 1;
