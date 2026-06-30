import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../supabase.js';
import { extractPdfTextFromDocument } from './pdfText.js';
import { parsePurchaseOrder } from './parsers/index.js';

function toJson(value) {
  return value === undefined ? null : value;
}

export async function listPurchaseOrders({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function getDocumentsForProcessing({ limit = 20, documentId = null } = {}) {
  let query = supabase
    .from('documents')
    .select('*')
    .in('status', ['downloaded', 'parse_error', 'parsed', 'needs_mapping'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (documentId) query = query.eq('id', documentId);

  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function upsertParsedOrder(document, parsed, text) {
  const header = parsed.header || {};
  const orderRow = {
    document_id: document.id,
    source_file_name: document.file_name,
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
    raw_json: toJson(parsed)
  };

  const { data: order, error: orderError } = await supabase
    .from('purchase_orders')
    .upsert(orderRow, { onConflict: 'document_id' })
    .select('*')
    .single();

  if (orderError) throw orderError;

  const { error: deleteError } = await supabase
    .from('purchase_order_lines')
    .delete()
    .eq('purchase_order_id', order.id);

  if (deleteError) throw deleteError;

  const lineRows = (parsed.lines || []).map(line => ({
    purchase_order_id: order.id,
    document_id: document.id,
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
    qty_sz1: line.qty_sz1,
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

  if (lineRows.length) {
    const { error: linesError } = await supabase
      .from('purchase_order_lines')
      .insert(lineRows);
    if (linesError) throw linesError;
  }

  const { error: docError } = await supabase
    .from('documents')
    .update({
      status: parsed.status || 'parsed',
      detected_customer: header.customer_raw || null,
      detected_po: header.order_no || null,
      ocr_text: text,
      raw_json: parsed,
      error_message: null
    })
    .eq('id', document.id);
  if (docError) throw docError;

  return { order, lineCount: lineRows.length, parsed };
}

export async function processDownloadedDocuments({ limit = 20, documentId = null } = {}) {
  const documents = await getDocumentsForProcessing({ limit, documentId });
  const results = [];

  for (const document of documents) {
    try {
      const text = await extractPdfTextFromDocument(document);
      const parsed = parsePurchaseOrder({ text, fileName: document.file_name, document });
      const saved = await upsertParsedOrder(document, parsed, text);
      results.push({
        document_id: document.id,
        file_name: document.file_name,
        status: saved.order.status,
        parser: parsed.parser,
        order_no: saved.order.order_no,
        line_count: saved.lineCount,
        missing_fields: parsed.needs_mapping,
        conflicts: parsed.conflicts || []
      });
    } catch (error) {
      await supabase
        .from('documents')
        .update({ status: 'parse_error', error_message: error.message })
        .eq('id', document.id);
      results.push({ document_id: document.id, file_name: document.file_name, status: 'parse_error', error: error.message });
    }
  }

  return { processed_count: results.length, results };
}

export async function ensureExportsDir() {
  const dir = path.resolve(process.cwd(), 'exports', 'a2000', new Date().toISOString().slice(0, 10));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
