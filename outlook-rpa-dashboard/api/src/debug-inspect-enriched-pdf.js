import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Uso: node api/src/debug-inspect-enriched-pdf.js <pdf1> [pdf2 ...]');
  process.exit(1);
}

function positiveQtyBuckets(line = {}) {
  const out = {};
  for (let index = 1; index <= 18; index += 1) {
    const key = `qty_sz${index}`;
    const value = line[key];
    if (Number(value) > 0) out[key] = value;
  }
  return out;
}

function lineResolutionSource(line = {}) {
  return line.raw?.upc_resolution?.source
    || line.raw?.sku_master?.source
    || line.raw?.composite_style_resolution?.source
    || line.raw?.nearest_composite_style_resolution?.source
    || line.raw?.style_similarity_resolution?.source
    || line.raw?.style_resolution?.source
    || null;
}

function summarize(file, parsed) {
  return {
    file: path.basename(file),
    source_document_order_index: parsed.header?.raw?.source_order_index || 1,
    source_document_order_count: parsed.header?.raw?.source_order_count || 1,
    parser: parsed.parser,
    document_family: parsed.document_family || null,
    layout_version: parsed.layout_version || null,
    header: {
      customer_raw: parsed.header?.customer_raw ?? null,
      customer_code: parsed.header?.customer_code ?? null,
      order_no: parsed.header?.order_no ?? null,
      order_date: parsed.header?.order_date ?? null,
      start_date: parsed.header?.start_date ?? null,
      cancel_date: parsed.header?.cancel_date ?? null,
      store_raw: parsed.header?.store_raw ?? null,
      store_code: parsed.header?.store_code ?? null,
      terms_raw: parsed.header?.terms_raw ?? null,
      terms_code: parsed.header?.terms_code ?? null,
      division_code: parsed.header?.division_code ?? null,
      warehouse_code: parsed.header?.warehouse_code ?? null,
      store_resolution: parsed.header?.raw?.store_master ?? null
    },
    status: parsed.status,
    needs_mapping: parsed.needs_mapping,
    warnings: parsed.warnings || [],
    conflicts: parsed.conflicts || [],
    lines: (parsed.lines || []).map((line) => ({
      line_no: line.line_no,
      customer_sku_raw: line.raw?.customer_sku_raw ?? line.customer_sku ?? null,
      customer_upc_raw: line.raw?.customer_upc_raw ?? line.customer_upc ?? null,
      style_raw: line.style_raw ?? null,
      style_code: line.style_code ?? null,
      color_raw: line.color_raw ?? null,
      color_code: line.color_code ?? null,
      color_description: line.raw?.sku_master?.color_description ?? null,
      color_abbr: line.raw?.sku_master?.color_abbr ?? null,
      internal_sku: line.internal_sku ?? null,
      master_sku: line.master_sku ?? null,
      master_upc: line.master_upc ?? null,
      size_raw: line.size_raw ?? null,
      size_code: line.size_code ?? null,
      scale_code: line.scale_code ?? null,
      scale_abbr: line.scale_abbr ?? null,
      qty_total: line.qty_total ?? null,
      qty_buckets: positiveQtyBuckets(line),
      sales_price: line.sales_price ?? null,
      list_price: line.list_price ?? null,
      warehouse_code: line.warehouse_code ?? null,
      division_code: line.master_division_code ?? line.division_code ?? null,
      resolution_source: lineResolutionSource(line),
      style_resolution: line.raw?.style_similarity_resolution || line.raw?.nearest_composite_style_resolution || line.raw?.style_resolution || null,
      color_resolution: line.raw?.description_color_resolution || line.raw?.trailing_style_suffix_color_resolution || line.raw?.color_resolution || line.raw?.unique_style_color_resolution || null,
      upc_resolution: line.raw?.upc_master || line.raw?.upc_resolution || line.raw?.upc_master_resolution || null,
      qty_bucket_resolution: line.raw?.qty_bucket_resolution || null,
      style_master_override: line.raw?.style_master_override || null,
      missing_fields: line.missing_fields || []
    }))
  };
}

for (const file of files) {
  const buffer = await fs.readFile(file);
  const text = await extractPdfTextFromBuffer(buffer);
  const document = { file_name: path.basename(file), subject: process.env.DEBUG_CUSTOMER_HINT || path.basename(path.dirname(file)) };
  const parsedOrders = parsePurchaseOrders({ text, fileName: path.basename(file), document });
  const summaries = parsedOrders.map((parsed) => summarize(file, parsed));
  console.log(JSON.stringify(summaries.length === 1 ? summaries[0] : summaries, null, 2));
}
