import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../supabase.js';
import { extractPdfTextFromDocument } from './pdfText.js';
import { parsePurchaseOrder, parsePurchaseOrders } from './parsers/index.js';

function toJson(value) {
  return value === undefined ? null : value;
}

function clean(value) {
  return String(value ?? '').trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function multiOrderPersistenceReady() {
  const value = String(process.env.A2000_MULTI_ORDER_PERSISTENCE_READY || '').trim().toUpperCase();
  return value === 'TRUE' || value === 'YES' || value === '1';
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

async function existingOrdersForDocument(documentId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('id, order_no')
    .eq('document_id', documentId);
  if (error) throw error;
  return data || [];
}

async function deleteOrderAndLines(orderId) {
  const { error: lineError } = await supabase
    .from('purchase_order_lines')
    .delete()
    .eq('purchase_order_id', orderId);
  if (lineError) throw lineError;

  const { error: orderError } = await supabase
    .from('purchase_orders')
    .delete()
    .eq('id', orderId);
  if (orderError) throw orderError;
}

function parsedOrderRow(document, parsed) {
  const header = parsed.header || {};
  return {
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
}

async function saveOrderRow(document, parsed) {
  const orderRow = parsedOrderRow(document, parsed);
  const orderNo = clean(orderRow.order_no);

  if (multiOrderPersistenceReady() && orderNo) {
    const { data: order, error } = await supabase
      .from('purchase_orders')
      .upsert(orderRow, { onConflict: 'document_id,order_no' })
      .select('*')
      .single();
    if (error) throw error;
    return order;
  }

  if (!multiOrderPersistenceReady()) {
    const { data: order, error } = await supabase
      .from('purchase_orders')
      .upsert(orderRow, { onConflict: 'document_id' })
      .select('*')
      .single();
    if (error) throw error;
    return order;
  }

  const { data: nullOrderRows, error: lookupError } = await supabase
    .from('purchase_orders')
    .select('id')
    .eq('document_id', document.id)
    .is('order_no', null);
  if (lookupError) throw lookupError;

  const existing = nullOrderRows || [];
  if (existing.length > 1) {
    for (const row of existing) await deleteOrderAndLines(row.id);
  }

  if (existing.length === 1) {
    const { data: order, error } = await supabase
      .from('purchase_orders')
      .update(orderRow)
      .eq('id', existing[0].id)
      .select('*')
      .single();
    if (error) throw error;
    return order;
  }

  const { data: order, error } = await supabase
    .from('purchase_orders')
    .insert(orderRow)
    .select('*')
    .single();
  if (error) throw error;
  return order;
}

async function replaceOrderLines(document, order, parsed) {
  const header = parsed.header || {};

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

  return lineRows.length;
}

async function upsertParsedOrder(document, parsed) {
  const order = await saveOrderRow(document, parsed);
  const lineCount = await replaceOrderLines(document, order, parsed);
  return { order, lineCount, parsed };
}

function aggregateDocumentStatus(parsedOrders) {
  if (!parsedOrders.length) return 'parse_error';
  if (parsedOrders.every(parsed => parsed.status === 'parsed')) return 'parsed';
  if (parsedOrders.some(parsed => parsed.status === 'needs_mapping')) return 'needs_mapping';
  return parsedOrders[0].status || 'parsed';
}

async function updateProcessedDocument(document, parsedOrders, text) {
  const customerCodes = unique(
    parsedOrders.map(parsed => clean(parsed.header?.customer_code)).filter(Boolean)
  );
  const orderNos = parsedOrders
    .map(parsed => clean(parsed.header?.order_no))
    .filter(Boolean);
  const documentRawJson = parsedOrders.length === 1
    ? parsedOrders[0]
    : {
        document_family: 'multi_order_document',
        order_count: parsedOrders.length,
        order_numbers: orderNos,
        orders: parsedOrders
      };

  const { error } = await supabase
    .from('documents')
    .update({
      status: aggregateDocumentStatus(parsedOrders),
      detected_customer: customerCodes.length === 1 ? customerCodes[0] : null,
      detected_po: orderNos.length ? orderNos.join(', ') : null,
      ocr_text: text,
      raw_json: documentRawJson,
      error_message: null
    })
    .eq('id', document.id);
  if (error) throw error;
}

async function removeStaleOrders(existingOrders, savedOrders) {
  const currentIds = new Set(savedOrders.map(saved => String(saved.order.id)));
  const stale = (existingOrders || []).filter(row => !currentIds.has(String(row.id)));
  for (const row of stale) await deleteOrderAndLines(row.id);
  return stale.length;
}

export async function processDownloadedDocuments({ limit = 20, documentId = null } = {}) {
  const documents = await getDocumentsForProcessing({ limit, documentId });
  const results = [];
  let processedOrderCount = 0;

  for (const document of documents) {
    try {
      const text = await extractPdfTextFromDocument(document);
      const multiOrderMode = multiOrderPersistenceReady();
      const parsedOrders = multiOrderMode
        ? parsePurchaseOrders({
            text,
            fileName: document.file_name,
            document
          })
        : [parsePurchaseOrder({
            text,
            fileName: document.file_name,
            document
          })];

      if (!parsedOrders.length) {
        throw new Error('No purchase order candidates were parsed from document.');
      }

      const existingOrders = multiOrderMode
        ? await existingOrdersForDocument(document.id)
        : [];
      const savedOrders = [];

      for (const [orderIndex, parsed] of parsedOrders.entries()) {
        const saved = await upsertParsedOrder(document, parsed);
        savedOrders.push(saved);
        processedOrderCount += 1;
        results.push({
          document_id: document.id,
          file_name: document.file_name,
          status: saved.order.status,
          parser: parsed.parser,
          order_no: saved.order.order_no,
          line_count: saved.lineCount,
          source_document_order_index: parsed.header?.raw?.source_order_index || orderIndex + 1,
          source_document_order_count: parsed.header?.raw?.source_order_count || parsedOrders.length,
          purchase_order_id: saved.order.id,
          missing_fields: parsed.needs_mapping,
          conflicts: parsed.conflicts || []
        });
      }

      const staleOrderCount = multiOrderMode
        ? await removeStaleOrders(existingOrders, savedOrders)
        : 0;
      await updateProcessedDocument(document, parsedOrders, text);

      for (const result of results.filter(item => item.document_id === document.id)) {
        result.stale_order_count_removed = staleOrderCount;
      }
    } catch (error) {
      await supabase
        .from('documents')
        .update({ status: 'parse_error', error_message: error.message })
        .eq('id', document.id);
      results.push({
        document_id: document.id,
        file_name: document.file_name,
        status: 'parse_error',
        error: error.message
      });
    }
  }

  return {
    processed_count: results.length,
    processed_document_count: documents.length,
    processed_order_count: processedOrderCount,
    multi_order_persistence_ready: multiOrderPersistenceReady(),
    results
  };
}

export async function ensureExportsDir() {
  const dir = path.resolve(process.cwd(), 'exports', 'a2000', new Date().toISOString().slice(0, 10));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
