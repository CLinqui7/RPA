import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(API_ROOT, 'training', 'all_customer_source_fixtures');
const BATCH_ROOT = path.join(API_ROOT, 'training', 'parser_fixture_pdfs');

const FIXTURES = [
  { root: SOURCE_ROOT, rel: '10 below/72041 American Exchange PO.pdf', document: { subject: '10BELOW' } },
  { root: SOURCE_ROOT, rel: 'ITSFASHION/stainless steel AMEX PO.pdf', document: { subject: 'ITS FASHION PURCHASE ORDERS' } },
  { root: SOURCE_ROOT, rel: 'MACYSBACKS/PO 4931768.pdf', document: { subject: 'MACYSBACKS' } },
  { root: SOURCE_ROOT, rel: 'MARSHALLS/hardcopie.PDF', document: { subject: 'MARSHALLS' } },
  { root: SOURCE_ROOT, rel: 'MESALVEINC/reportPO-24027385.pdf', document: { subject: 'MESALVEINC' } },
  { root: SOURCE_ROOT, rel: 'OLLIES/POLINK 1.pdf', document: { subject: 'OLLIES' } },
  { root: SOURCE_ROOT, rel: 'SHOE4500/hardcopie.PDF', document: { subject: 'SHOE4500' } },
  { root: SOURCE_ROOT, rel: 'TILLYS/hardcopie.pdf', document: { subject: 'TILLYS' } },
  { root: SOURCE_ROOT, rel: 'TJMAXX/60 089114.pdf', document: { subject: 'TJMAXX' } },
  { root: SOURCE_ROOT, rel: 'VARIETYWHO/1885387.pdf', document: { subject: 'VARIETYWHO' } },
  { root: SOURCE_ROOT, rel: 'Versona/615628 earlier ship.pdf', document: { subject: 'VERSONA PO 615628' } },
  { root: SOURCE_ROOT, rel: 'ZUMIEZ/4587_476085_20260204134804 LINKIN PARK 1.pdf', document: { subject: 'ZUMIEZ' } },
  { root: SOURCE_ROOT, rel: 'beallsoutl/hardcopie nueva.pdf', document: { subject: 'BEALLSOUTL' } },
  { root: SOURCE_ROOT, rel: 'beallsoutl/hardcopie vieja.PDF', document: { subject: 'BEALLSOUTL' } },
  { root: SOURCE_ROOT, rel: 'citi/PurchaseOrder-0000199431-00-009721.pdf', document: { subject: 'CITI' } },
  { root: SOURCE_ROOT, rel: 'colony/COLONY LINKEDIN.pdf', document: { subject: 'COLONY' } },
  { root: SOURCE_ROOT, rel: 'gabrielbro/VendorCopy_13003334.pdf', document: { subject: 'GABRIELBRO' } },
  { root: SOURCE_ROOT, rel: 'ipc/IPC PO-GG-6026.pdf', document: { subject: 'IPC' } },
  { root: SOURCE_ROOT, rel: 'SPENCER/spencer.PDF', document: { subject: 'SPENCER' } },
  { root: BATCH_ROOT, rel: 'PO_127_1674444_0_US.pdf', document: { subject: 'CARNIVAL' } },
  { root: BATCH_ROOT, rel: 'PO_127_1674445_0_US.pdf', document: { subject: 'CARNIVAL' } },
  { root: BATCH_ROOT, rel: 'PO #952211.pdf', document: { subject: 'OLLIES' } }
];

function positiveQtyBuckets(line = {}) {
  const out = {};
  for (let index = 1; index <= 18; index += 1) {
    const key = `qty_sz${index}`;
    if (Number(line[key]) > 0) out[key] = Number(line[key]);
  }
  return out;
}

function styleSource(line = {}) {
  return line.raw?.upc_resolution?.source
    || line.raw?.nearest_composite_style_resolution?.source
    || line.raw?.style_similarity_resolution?.source
    || line.raw?.composite_style_resolution?.source
    || line.raw?.trailing_style_suffix_resolution?.source
    || line.raw?.style_resolution?.source
    || line.raw?.sku_master?.source
    || null;
}

function colorSource(line = {}) {
  return line.raw?.upc_resolution?.source
    || line.raw?.description_color_resolution?.source
    || line.raw?.trailing_style_suffix_color_resolution?.source
    || line.raw?.color_resolution?.source
    || line.raw?.composite_style_resolution?.source
    || line.raw?.unique_style_color_resolution?.source
    || line.raw?.sku_master?.source
    || null;
}

const documents = [];
const lines = [];
for (const fixture of FIXTURES) {
  const filePath = path.join(fixture.root, fixture.rel);
  const text = await extractPdfTextFromBuffer(await fs.readFile(filePath));
  const fileName = path.basename(filePath);
  const orders = parsePurchaseOrders({ text, fileName, document: { file_name: fileName, file_path: filePath, ...fixture.document } });
  documents.push({ source: fixture.rel, source_order_count: orders.length, orders: orders.map((item) => item.header?.order_no || null) });
  for (const item of orders) {
    for (const line of item.lines || []) {
      lines.push({
        source: fixture.rel,
        customer: item.header?.customer_code || null,
        order_no: item.header?.order_no || null,
        source_order_index: item.header?.raw?.source_order_index || 1,
        line_no: line.line_no,
        style_raw: line.style_raw ?? null,
        style_code: line.style_code ?? null,
        style_match_source: styleSource(line),
        color_raw: line.color_raw ?? null,
        color_code: line.color_code ?? null,
        color_description: line.raw?.sku_master?.color_description ?? null,
        color_match_source: colorSource(line),
        customer_upc_raw: line.customer_upc ?? line.raw?.customer_upc_raw ?? null,
        master_upc: line.master_upc ?? null,
        master_upcs_by_size: line.master_upcs_by_size || [],
        master_upc_source: line.raw?.upc_master?.source || line.raw?.upc_resolution?.source || line.raw?.upc_master_by_size?.source || null,
        master_upc_reason: line.raw?.upc_master?.reason || line.raw?.upc_resolution?.reason || line.raw?.upc_master_resolution?.reason || null,
        master_upc_candidate_count: line.raw?.upc_master_candidates?.length || line.raw?.upc_resolution?.candidate_count || 0,
        internal_sku: line.internal_sku ?? null,
        size_raw: line.size_raw ?? null,
        scale_code: line.scale_code ?? null,
        qty_total: line.qty_total ?? null,
        qty_buckets: positiveQtyBuckets(line),
        style_resolved: Boolean(line.style_code),
        color_resolved: Boolean(line.color_code),
        master_upc_resolved: Boolean(line.master_upc),
        master_upcs_by_size_resolved: Array.isArray(line.master_upcs_by_size) && line.master_upcs_by_size.length > 0 && (line.raw?.upc_master_by_size?.failures || []).length === 0,
        master_upc_status: line.master_upc
          ? 'unique_master_upc'
          : (Array.isArray(line.master_upcs_by_size) && line.master_upcs_by_size.length > 0 && (line.raw?.upc_master_by_size?.failures || []).length === 0)
            ? 'all_printed_sizes_have_master_upc'
            : line.customer_upc_raw
              ? 'customer_upc_only_or_no_unique_master_upc'
              : 'unresolved_master_upc',
        strict_missing: line.missing_fields || []
      });
    }
  }
}

const unresolvedStyle = lines.filter((line) => !line.style_resolved);
const unresolvedColor = lines.filter((line) => !line.color_resolved);
const uniqueMasterUpc = lines.filter((line) => line.master_upc_resolved);
const multiSizeMasterUpcs = lines.filter((line) => !line.master_upc_resolved && line.master_upcs_by_size_resolved);
const unresolvedMasterUpc = lines.filter((line) => !line.master_upc_resolved && !line.master_upcs_by_size_resolved);
const upcEvidenceLines = lines.filter((line) => line.master_upc_resolved || line.master_upcs_by_size_resolved || Boolean(line.customer_upc_raw));
const noUpcEvidenceLines = lines.filter((line) => !line.master_upc_resolved && !line.master_upcs_by_size_resolved && !line.customer_upc_raw);
const report = {
  suite: 'HARDCOPY_MASTER_STYLE_COLOR_UPC_AUDIT',
  source_documents: FIXTURES.length,
  parsed_orders: documents.reduce((sum, item) => sum + item.source_order_count, 0),
  line_count: lines.length,
  resolved_style_lines: lines.length - unresolvedStyle.length,
  unresolved_style_lines: unresolvedStyle.length,
  resolved_color_lines: lines.length - unresolvedColor.length,
  unresolved_color_lines: unresolvedColor.length,
  unique_master_upc_lines: uniqueMasterUpc.length,
  multi_size_master_upcs_resolved_lines: multiSizeMasterUpcs.length,
  master_upc_coverage_lines: uniqueMasterUpc.length + multiSizeMasterUpcs.length,
  unresolved_master_upc_lines: unresolvedMasterUpc.length,
  any_upc_evidence_lines: upcEvidenceLines.length,
  no_upc_evidence_lines: noUpcEvidenceLines.length,
  unresolved_summary: {
    styles: unresolvedStyle.map((line) => ({ source: line.source, order_no: line.order_no, line_no: line.line_no, style_raw: line.style_raw })),
    colors: unresolvedColor.map((line) => ({ source: line.source, order_no: line.order_no, line_no: line.line_no, style_code: line.style_code, color_raw: line.color_raw })),
    master_upcs: unresolvedMasterUpc.map((line) => ({ source: line.source, order_no: line.order_no, line_no: line.line_no, style_code: line.style_code, color_code: line.color_code, size_raw: line.size_raw, customer_upc_raw: line.customer_upc_raw, candidate_count: line.master_upc_candidate_count, reason: line.master_upc_reason, status: line.master_upc_status })),
    multi_size_master_upcs: multiSizeMasterUpcs.map((line) => ({ source: line.source, order_no: line.order_no, line_no: line.line_no, style_code: line.style_code, color_code: line.color_code, resolved_sizes: line.master_upcs_by_size })),
    no_upc_evidence: noUpcEvidenceLines.map((line) => ({ source: line.source, order_no: line.order_no, line_no: line.line_no, style_code: line.style_code, color_code: line.color_code, size_raw: line.size_raw, candidate_count: line.master_upc_candidate_count, reason: line.master_upc_reason }))
  },
  documents,
  lines
};
console.log(JSON.stringify(report, null, 2));
