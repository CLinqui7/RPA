import fs from 'node:fs/promises';
import path from 'node:path';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrder } from './po/parsers/index.js';

const file = process.argv[2];
if (!file) {
  console.error('Uso: node api/src/debug-parse-local-pdf.js <ruta-pdf>');
  process.exit(1);
}

const buffer = await fs.readFile(file);
const text = await extractPdfTextFromBuffer(buffer);
const parsed = parsePurchaseOrder({ text, fileName: path.basename(file), document: { file_name: path.basename(file) } });

console.log(JSON.stringify({
  file,
  textPreview: text.slice(0, 2500),
  parser: parsed.parser,
  order_no: parsed.header?.order_no,
  dept: parsed.header?.dept_code,
  store: parsed.header?.store_code,
  line_count: parsed.lines?.length || 0,
  lines: parsed.lines,
  totals: parsed.totals,
  missing: parsed.needs_mapping,
  conflicts: parsed.conflicts
}, null, 2));
