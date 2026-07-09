import fs from 'node:fs/promises';
import path from 'node:path';
import { supabase } from '../supabase.js';
import { ensureExportsDir } from '../po/poRepository.js';
import { rowsToCsv, A2000_HEADER_COLUMNS, A2000_LINE_COLUMNS } from './csv.js';
import { applyExplicitA2000QtyBuckets, hasBlockingA2000Conflicts, isStrictA2000Header, isStrictA2000Line } from './strictImport.js';

function toExportUrl(filePath) {
  const marker = `${path.sep}exports${path.sep}`;
  const pos = filePath.indexOf(marker);
  if (pos >= 0) {
    return `/exports/${filePath.slice(pos + marker.length).replaceAll(path.sep, '/')}`;
  }
  const normalized = filePath.replaceAll(path.sep, '/');
  const fallbackPos = normalized.indexOf('/exports/');
  if (fallbackPos >= 0) return normalized.slice(fallbackPos);
  return normalized;
}

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function trimMax(value, max = 20) {
  return clean(value).slice(0, max);
}

function headerDivisionForExport(order = {}) {
  return clean(order.division_code);
}

function headerWarehouseForExport(order = {}) {
  return clean(order.warehouse_code);
}

function lineWarehouseForExport(order = {}, line = {}) {
  return clean(line.warehouse_code || order.warehouse_code);
}

function lineHasImportableStyle(_order, line = {}) {
  return !!(clean(line.style_code) && clean(line.color_code));
}

function isImportableLine(order = {}, line = {}) {
  return lineHasImportableStyle(order, line) && isStrictA2000Line(order, line);
}

function isImportableOrder(order = {}) {
  const lines = order.purchase_order_lines || [];
  return order.status === 'parsed'
    && !hasBlockingA2000Conflicts(order)
    && isStrictA2000Header(order)
    && lines.some(line => isImportableLine(order, line));
}

function formatDateForA2000(value) {
  const v = clean(value);
  if (!v) return '';
  // The functional samples use M/D/YYYY. Keep existing M/D/YYYY if already supplied.
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(v)) return v;
  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(v)) {
    const [m, d, yy] = v.split('/');
    return `${Number(m)}/${Number(d)}/20${yy}`;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    const [yyyy, mm, dd] = v.slice(0, 10).split('-');
    return `${Number(mm)}/${Number(dd)}/${yyyy}`;
  }
  return v;
}

function blankRow(columns) {
  return Object.fromEntries(columns.map(column => [column, '']));
}

function orderToA2000HeaderRow(order) {
  const row = blankRow(A2000_HEADER_COLUMNS);

  row.SEQ_ORDER_NO = '';
  row.CUST_NO = clean(order.customer_code); // Must be A2000 customer code. Leave blank if unmapped.
  row.STORE_NO = clean(order.store_code);
  row.ORDER_NO = clean(order.order_no);
  row.ORDER_DATE = formatDateForA2000(order.order_date);
  row.START_DATE = formatDateForA2000(order.start_date);
  row.CANCEL_DATE = formatDateForA2000(order.cancel_date);
  row.BOOK_DATE = formatDateForA2000(order.book_date);
  row.CUST_DEPT = clean(order.dept_code);
  row.REGION = clean(order.region_code);
  row.DC_NO = clean(order.dc_code);
  row.DIV_NO = headerDivisionForExport(order);
  row.BOOK_SEASON = clean(order.book_season_code);
  row.SHIP_VIA_NO = clean(order.ship_via_code);
  row.PRIORITY = clean(order.priority_code);
  row.TERM_NO = clean(order.terms_code);
  row.DISC_CODE = clean(order.discount_code);
  row.FACTOR_NO = clean(order.factor_code);
  row.FACTOR_APPR_NO = clean(order.factor_approval_no);
  row.SMAN1_NO = clean(order.salesman1_code);
  row.SMAN2_NO = clean(order.salesman2_code);
  row.SMAN3_NO = clean(order.salesman3_code);
  row.SMAN1_COMM = clean(order.salesman1_comm);
  row.SMAN2_COMM = clean(order.salesman2_comm);
  row.SMAN3_COMM = clean(order.salesman3_comm);
  row.USER_REF1 = trimMax(order.order_no || order.source_file_name || order.customer_raw, 20);
  row.USER_REF2 = trimMax(order.terms_raw || '', 20);
  row.BACK_ORDER = clean(order.back_order);
  row.MASTER_INVOICE = clean(order.master_invoice);
  row.REORDER = clean(order.reorder);
  row.TAG = clean(order.tag);
  row.ORDER_ALIAS = clean(order.order_alias);
  row.CURRENCY = clean(order.currency);
  row.EXCHANGE_RATE = clean(order.exchange_rate);
  row.USER_REF3 = trimMax(order.status, 20);
  row.USER_REF4 = '';
  row.USER_REF5 = '';
  row.DEF_WHOUSE = headerWarehouseForExport(order);
  row.SH_RULE = clean(order.shipping_handling_rule);
  row.FIRST_COST_RULE = clean(order.first_cost_rule);
  row.PRICE_LIST_ID = clean(order.price_list_id);
  row.PROMO_CODE = clean(order.promo_code);
  row.ORDER_TYPE = clean(order.order_type);
  row.ORDER_HOLD = clean(order.order_hold_code);
  row.EVENT_DATE = formatDateForA2000(order.event_date);
  row.SALES_TAX1 = clean(order.sales_tax1);
  row.SALES_TAX2 = clean(order.sales_tax2);
  row.SALES_TAX1L = clean(order.sales_tax1l);
  row.TAX_AUTH = clean(order.tax_authority);

  return row;
}

function lineToA2000LineRow(order, line) {
  const row = blankRow(A2000_LINE_COLUMNS);

  row.SEQ_ORDER_NO = '';
  row.LINE_NO = clean(line.line_no);
  row.CUST_NO = clean(order.customer_code);
  row._NO = clean(order.store_code);
  row.ORDER_NO = clean(order.order_no);
  row.STYLE = clean(line.style_code);
  row.COLOR_NO = clean(line.color_code);
  row.SALES_PRICE = clean(line.sales_price);
  row.WHOUSE = lineWarehouseForExport(order, line);
  applyExplicitA2000QtyBuckets(row, line);
  // Keep the import lean. A2000 rejected long values in CUST_STYLE1 and REF.
  // The functional sample leaves these optional fields blank, so do the same for demo import.
  // Size Name/scale labels from masters are not proven to be ORDER_LI.SIZE_NO.
  // Export SIZE_NO only when an explicit A2000 size number has been resolved.
  row.SIZE_NO = clean(line.a2000_size_no);
  row.CUST_STYLE1 = trimMax(line.cust_style1 || '', 6);
  row.CUST_STYLE2 = trimMax(line.cust_style2 || '', 20);
  row.SUB_STYLE = clean(line.sub_style);
  row.SUB_COLOR_NO = clean(line.sub_color_code);
  row.REF = trimMax(line.reference || '', 15);
  row.ORDER_ALIAS = clean(order.order_alias);
  row.LIST_PRICE = clean(line.list_price);
  row.SMAN1_NO = clean(order.salesman1_code);
  row.SMAN2_NO = clean(order.salesman2_code);
  row.SMAN3_NO = clean(order.salesman3_code);
  row.SMAN1_COMM = clean(order.salesman1_comm);
  row.SMAN2_COMM = clean(order.salesman2_comm);
  row.SMAN3_COMM = clean(order.salesman3_comm);

  return row;
}

export async function createDemoA2000Batch({
  includeNeedsMapping = true,
  includeAlreadyBatched = true,
  forceDemo = true,
  includeHeaderRow = true
} = {}) {
  let query = supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .order('created_at', { ascending: true });

  if (!includeNeedsMapping) query = query.eq('status', 'parsed');

  const { data: orders, error } = await query;
  if (error) throw error;

  // Import-safe demo mode: do NOT export rows that A2000 will obviously reject.
  // Earlier versions exported debug rows and incomplete parsers, causing User Ref max length,
  // missing customer/store/division and no-lines errors. Here we export only rows with usable
  // header values and at least one valid line.
  const eligible = (orders || []).filter(order => {
    if (!forceDemo && !includeAlreadyBatched && order.batch_id) return false;
    return isImportableOrder(order);
  });

  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const exportDir = await ensureExportsDir();
  const headerFileName = `A2000_HEADER_BATCH_EXACT_${timestamp}.csv`;
  const linesFileName = `A2000_LINES_BATCH_EXACT_${timestamp}.csv`;
  const headerPath = path.join(exportDir, headerFileName);
  const linesPath = path.join(exportDir, linesFileName);

  const headerRows = eligible.map(orderToA2000HeaderRow);

  const lineRows = [];
  const lineSeen = new Set();
  for (const order of eligible) {
    for (const line of order.purchase_order_lines || []) {
      if (!isImportableLine(order, line)) continue;
      const row = lineToA2000LineRow(order, line);
      const dedupeKey = [
        row.ORDER_NO,
        row.LINE_NO,
        row.STYLE,
        row.COLOR_NO,
        row.SALES_PRICE,
        row.WHOUSE,
        row.SIZE_NO,
        row.QTY_SZ1,
        row.QTY_SZ2,
        row.QTY_SZ3,
        row.QTY_SZ4,
        row.QTY_SZ5,
        row.QTY_SZ6,
        row.QTY_SZ7,
        row.QTY_SZ8,
        row.QTY_SZ9,
        row.QTY_SZ10,
        row.QTY_SZ11,
        row.QTY_SZ12,
        row.QTY_SZ13,
        row.QTY_SZ14,
        row.QTY_SZ15,
        row.QTY_SZ16,
        row.QTY_SZ17,
        row.QTY_SZ18
      ].map(value => String(value || '').trim()).join('|');
      if (lineSeen.has(dedupeKey)) continue;
      lineSeen.add(dedupeKey);
      lineRows.push(row);
    }
  }

  await fs.writeFile(headerPath, rowsToCsv(A2000_HEADER_COLUMNS, headerRows, { includeHeader: includeHeaderRow }), 'utf-8');
  await fs.writeFile(linesPath, rowsToCsv(A2000_LINE_COLUMNS, lineRows, { includeHeader: includeHeaderRow }), 'utf-8');

  const { data: batch, error: batchError } = await supabase
    .from('a2000_import_batches')
    .insert({
      status: 'generated_demo_exact_a2000_format',
      orders_count: eligible.length,
      header_rows_count: headerRows.length,
      line_rows_count: lineRows.length,
      header_file_path: headerPath,
      lines_file_path: linesPath,
      raw_json: {
        note: 'IMPORT-SAFE DEMO MODE: exports only importable parsed orders in the exact A2000 distro header and distro lines layouts supplied by the functional import examples. Only master-resolved A2000 codes and explicit QTY_SZ1...QTY_SZ18 buckets are exported; raw style/color/qty totals never fall through into import fields.',
        includeNeedsMapping,
        includeAlreadyBatched,
        forceDemo,
        includeHeaderRow,
        header_columns_count: A2000_HEADER_COLUMNS.length,
        line_columns_count: A2000_LINE_COLUMNS.length,
        header_url: toExportUrl(headerPath),
        lines_url: toExportUrl(linesPath)
      }
    })
    .select('*')
    .single();

  if (batchError) throw batchError;

  if (eligible.length) {
    const ids = eligible.map(order => order.id);
    await supabase.from('purchase_orders').update({ batch_id: batch.id }).in('id', ids);
  }

  return {
    batch,
    orders_count: eligible.length,
    header_rows_count: headerRows.length,
    line_rows_count: lineRows.length,
    header_file_path: headerPath,
    lines_file_path: linesPath,
    header_url: toExportUrl(headerPath),
    lines_url: toExportUrl(linesPath),
    header_file_name: headerFileName,
    lines_file_name: linesFileName,
    header_columns_count: A2000_HEADER_COLUMNS.length,
    line_columns_count: A2000_LINE_COLUMNS.length,
    preview: {
      headers: headerRows.slice(0, 5),
      lines: lineRows.slice(0, 10)
    }
  };
}

export async function listDemoBatches({ limit = 50 } = {}) {
  const { data, error } = await supabase
    .from('a2000_import_batches')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
