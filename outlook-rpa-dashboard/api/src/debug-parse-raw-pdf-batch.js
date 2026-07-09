import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parseRawPurchaseOrder } from './po/parsers/index.js';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Uso: node api/src/debug-parse-raw-pdf-batch.js <pdf1> <pdf2> ...');
  process.exit(1);
}

const results = [];
for (const file of files) {
  try {
    const buffer = await fs.readFile(file);
    const text = await extractPdfTextFromBuffer(buffer);
    const parsed = parseRawPurchaseOrder({
      text,
      fileName: path.basename(file),
      document: { file_name: path.basename(file) }
    });

    results.push({
      file,
      parser: parsed.parser,
      confidence: parsed.confidence,
      document_family: parsed.document_family || null,
      layout_version: parsed.layout_version || null,
      document_identity: parsed.document_identity || null,
      header: parsed.header || null,
      line_count: parsed.lines?.length || 0,
      totals: parsed.totals || null,
      conflicts: parsed.conflicts || [],
      lines: (parsed.lines || []).map((line) => ({
        line_no: line.line_no,
        customer_sku: line.customer_sku ?? null,
        upc: line.upc ?? null,
        style_raw: line.style_raw ?? null,
        style_code: line.style_code ?? null,
        color_raw: line.color_raw ?? null,
        color_code: line.color_code ?? null,
        size_raw: line.size_raw ?? null,
        description: line.description ?? null,
        sales_price: line.sales_price ?? null,
        list_price: line.list_price ?? null,
        qty_total: line.qty_total ?? null,
        qty_sz1: line.qty_sz1 ?? null,
        raw: line.raw || {}
      }))
    });
  } catch (error) {
    results.push({ file, status: 'error', error: error.stack || error.message });
  }
}

console.log(JSON.stringify(results, null, 2));
