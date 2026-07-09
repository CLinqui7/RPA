import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders, parseRawPurchaseOrders } from './po/parsers/index.js';

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

function codes(items = []) {
  return (items || []).map((item) => item.code || item.field || 'unknown');
}

function lineSummary(line = {}) {
  const qtyBuckets = {};
  for (let index = 1; index <= 18; index += 1) {
    const key = `qty_sz${index}`;
    if (line[key] !== null && line[key] !== undefined) qtyBuckets[key] = line[key];
  }
  return {
    line_no: line.line_no,
    customer_sku: line.customer_sku || line.customer_sku_raw || null,
    customer_upc: line.customer_upc || line.upc || line.raw?.customer_upc_raw || null,
    master_upc: line.master_upc || null,
    master_upcs_by_size: line.master_upcs_by_size || [],
    style_raw: line.style_raw || null,
    style_code: line.style_code || null,
    color_raw: line.color_raw || null,
    color_code: line.color_code || null,
    description: line.description || null,
    size_raw: line.size_raw || null,
    scale_code: line.scale_code || null,
    qty_total: line.qty_total ?? null,
    qty_buckets: qtyBuckets,
    sales_price: line.sales_price ?? null,
    list_price: line.list_price ?? null,
    warehouse_code: line.warehouse_code || null,
    resolution_source: line.raw?.upc_resolution?.source || line.raw?.style_color_resolution?.source || line.raw?.sku_master?.source || null,
    raw: line.raw || {}
  };
}

const results = [];
for (const fixture of FIXTURES) {
  const filePath = path.join(FIXTURE_ROOT, fixture.rel);
  const buffer = await fs.readFile(filePath);
  const text = await extractPdfTextFromBuffer(buffer);
  const fileName = path.basename(filePath);
  const document = { file_name: fileName, file_path: filePath, ...(fixture.document || {}) };
  const rawOrders = parseRawPurchaseOrders({ text, fileName, document });
  const enrichedOrders = parsePurchaseOrders({ text, fileName, document });
  const orderCount = Math.max(rawOrders.length, enrichedOrders.length);
  const orders = [];
  for (let index = 0; index < orderCount; index += 1) {
    const raw = rawOrders[index] || {};
    const enriched = enrichedOrders[index] || {};
    orders.push({
      source_order_index: index + 1,
      source_order_count: orderCount,
      raw_parser: raw.parser || null,
      enriched_parser: enriched.parser || null,
      status: enriched.status || null,
      document_identity: raw.document_identity || {},
      raw_header: raw.header || {},
      enriched_header: enriched.header || {},
      needs_mapping: enriched.needs_mapping || {},
      conflicts: codes(enriched.conflicts),
      warnings: codes(enriched.warnings),
      totals: enriched.totals || raw.totals || {},
      raw_lines: (raw.lines || []).map(lineSummary),
      enriched_lines: (enriched.lines || []).map(lineSummary)
    });
  }
  results.push({
    source: fixture.rel,
    expected_parser: fixture.parser,
    expected_customer: fixture.customer,
    source_order_count: orderCount,
    orders
  });
}

console.log(JSON.stringify({
  suite: 'ALL_HARDCOPY_READING_DUMP',
  source_pdf_count: results.length,
  parsed_order_count: results.reduce((sum, item) => sum + item.source_order_count, 0),
  results
}, null, 2));
