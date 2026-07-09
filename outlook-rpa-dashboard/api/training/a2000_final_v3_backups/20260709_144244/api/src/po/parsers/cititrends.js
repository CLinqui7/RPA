import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

const KNOWN_COLORS = [
  'BLACK-OFF BLACK', 'PINK/BLACK', 'RED/BLACK', 'OFF BLACK', 'WHITE', 'BLACK',
  'PINK', 'YELLOW', 'BLUE', 'RED', 'GREEN', 'BROWN', 'MULTI', 'NATURAL',
  'GREY', 'GRAY', 'PURPLE', 'ORANGE', 'SILVER', 'GOLD', 'TAN-BEIGE-KHAKI',
  'GOLD-MUSTARD', 'BLUSH'
];

function cleanLine(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function getLines(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n+/)
    .map(cleanLine)
    .filter(Boolean);
}

function money(value) {
  return normalizeMoney(String(value || '').replace(/[$,]/g, ''));
}

function int(value) {
  return normalizeInteger(String(value || '').replace(/[,]/g, ''));
}

function extractBetweenTableMarkers(lines) {
  const start = lines.findIndex((line) => /Vendor\s+Style\s+Description\s*\/\s*Color\/?\s*Item\s+Number/i.test(line));
  if (start < 0) return lines;
  let end = lines.findIndex((line, index) => index > start && /\*\*\*\s*End\s+of\s+Order\s*\*\*\*/i.test(line));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}

function splitDescriptionAndColor(value) {
  const raw = cleanLine(value);
  const upper = raw.toUpperCase();
  for (const color of [...KNOWN_COLORS].sort((a, b) => b.length - a.length)) {
    if (upper.endsWith(color)) {
      return {
        description: raw.slice(0, raw.length - color.length).trim() || raw,
        color_raw: color
      };
    }
  }
  const parts = raw.split(/\s+/);
  return {
    description: parts.slice(0, -1).join(' ') || raw,
    color_raw: parts.length > 1 ? parts.at(-1) : null
  };
}

function parseStyleLine(line) {
  const value = cleanLine(line);
  if (!value) return null;
  if (/^(Vendor Style|MSRP|Total|Reference PO|Page\s+\d+|Ticket Option|Vendor\b|Ship To\b|Comments\b)/i.test(value)) return null;
  if (/^(\d{4}-\d{6}-\d{7}-\d{4}-\d{5})\b/.test(value)) return null;
  if (/^\d+\s+PAIRS\b/i.test(value)) return null;
  const match = value.match(/^([A-Z0-9][A-Z0-9\-\/]{1,40})\s+(.+)$/i);
  if (!match) return null;
  const vendorStyle = match[1].trim().toUpperCase();
  const descriptionColor = cleanLine(match[2]);
  if (!descriptionColor) return null;
  const split = splitDescriptionAndColor(descriptionColor);
  return {
    vendor_style_raw: vendorStyle,
    style_raw: vendorStyle,
    description: split.description,
    color_raw: split.color_raw,
    source_line: value
  };
}

function parseDetailLine(line) {
  const value = cleanLine(line);
  // Printed layout: Item Number, UPC, optional MSRP, Cost, Size, Quantity.
  const detail = value.match(/(\d{4}-\d{6}-\d{7}-\d{4}-\d{5})\s+(\d{11,14})(?:\s+(\d+(?:\.\d{2})))?\s+(\d+(?:\.\d{2,4}))\s+(-|[A-Z0-9.\/\-]+)\s+([\d,]+)/i);
  if (!detail) return null;
  return {
    customer_sku: detail[1],
    upc: detail[2],
    list_price: money(detail[3]),
    sales_price: money(detail[4]),
    size_raw: detail[5],
    qty_total: int(detail[6]),
    source_line: value
  };
}

function findPreviousStyleLine(tableLines, detailIndex) {
  for (let i = detailIndex - 1; i >= 0; i -= 1) {
    const parsed = parseStyleLine(tableLines[i]);
    if (parsed) return parsed;
  }
  return null;
}

function findNextNote(tableLines, detailIndex) {
  const next = cleanLine(tableLines[detailIndex + 1] || '');
  return /^\d+\s+PAIRS\b/i.test(next) ? next : null;
}

function extractItems(text) {
  const tableLines = extractBetweenTableMarkers(getLines(text));
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < tableLines.length; i += 1) {
    const detail = parseDetailLine(tableLines[i]);
    if (!detail) continue;
    const style = findPreviousStyleLine(tableLines, i) || {};
    const key = [detail.customer_sku, detail.upc, detail.sales_price, detail.qty_total].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      line_no: rows.length + 1,
      customer_sku: detail.customer_sku,
      ticket_sku: null,
      upc: detail.upc,
      vendor_style_raw: style.vendor_style_raw || null,
      style_raw: style.style_raw || null,
      style_code: null,
      description: style.description || null,
      color_raw: style.color_raw || null,
      color_code: null,
      size_raw: detail.size_raw,
      size_code: null,
      list_price: detail.list_price,
      sales_price: detail.sales_price,
      qty_total: detail.qty_total,
      warehouse_code: null,
      raw: {
        source: 'cititrends_table_v4_master_only',
        style_line: style.source_line || null,
        detail_line: detail.source_line,
        note: findNextNote(tableLines, i),
        customer_upc_raw: detail.upc,
        upc_semantics: 'UPC',
        style_resolution_hint: style.vendor_style_raw ? 'EXACT_MASTER_SKU_NORMALIZED' : null,
        quantity_raw: detail.qty_total,
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'QUANTITY',
        pdf_msrp: detail.list_price
      }
    });
  }
  return rows;
}

function extractPoNumber(oneLine) {
  return oneLine.match(/Purchase\s+Order\s+(\d{6,})/i)?.[1]
    || oneLine.match(/Citi\s+Trends\s+-\s+Purchase\s+Order\s+(\d{6,})/i)?.[1]
    || null;
}

function extractDates(oneLine) {
  let match = oneLine.match(/Order\s+Date\s+Ship\s+On\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (!match) match = oneLine.match(/Order\s+Date\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+Ship\s+On\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (!match) match = oneLine.match(/Ship\s+On\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return { order_date: normalizeDate(match?.[1]), start_date: normalizeDate(match?.[2]), cancel_date: normalizeDate(match?.[3]) };
}

function extractVendorNumber(oneLine) {
  return oneLine.match(/Vendor\s+AMERICAN\s+EXCH(?:A|N)N?GE\s+TIME\s+(\d{4,8})/i)?.[1]
    || oneLine.match(/Vendor\s+.*?\s+(\d{4,8})\s+Ship\s+To/i)?.[1]
    || null;
}

export function parseCitiTrends({ text }) {
  const rawText = String(text || '');
  const oneLine = compactText(rawText);
  const orderNo = extractPoNumber(oneLine);
  const lines = extractItems(rawText);
  const customerRaw = cleanLine(oneLine.match(/\b(Citi\s+Trends)\b/i)?.[1]) || null;
  const termsRaw = oneLine.match(/\b(NET\s+\d+\s+DAYS\s+ROG)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
  const dates = extractDates(oneLine);
  const totalAmount = oneLine.match(/Total\s+\$\s*([\d,]+\.\d{2})/i)?.[1] || null;
  const totalQty = oneLine.match(/Total\s+\$\s*[\d,]+\.\d{2}\s+([\d,]+)/i)?.[1] || null;
  const parsedTotalQty = int(totalQty);
  const parsedTotalAmount = normalizeMoney(totalAmount);
  const calculatedQty = lines.reduce((acc, line) => acc + Number(line.qty_total || 0), 0);
  const calculatedAmount = lines.reduce((acc, line) => acc + Number(line.qty_total || 0) * Number(line.sales_price || 0), 0);
  const conflicts = [];
  if (parsedTotalQty && calculatedQty && parsedTotalQty !== calculatedQty) {
    conflicts.push({ field: 'total_qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, pdf_total: parsedTotalQty, calculated_from_lines: calculatedQty, message: 'Citi PDF total quantity differs from extracted line quantity.' });
  }
  if (parsedTotalAmount !== null && calculatedAmount && Math.abs(parsedTotalAmount - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'total_amount', code: 'printed_total_mismatch', severity: 'high', blocking: true, pdf_total: parsedTotalAmount, calculated_from_lines: calculatedAmount, message: 'Citi PDF total amount differs from extracted line extension sum.' });
  }

  return {
    parser: 'cititrends',
    document_family: 'citi_trends_purchase_order',
    layout_version: 'cititrends_table_v4_master_only',
    document_identity: { legal_entity_raw: customerRaw, brand_raw: customerRaw, customer_candidate: 'CITI', customer_candidate_source: 'document_family', a2000_customer_code: null },
    confidence: lines.length ? 0.95 : 0.45,
    header: {
      customer_raw: customerRaw, customer_code: null, order_no: orderNo,
      order_date: dates.order_date, start_date: dates.start_date, cancel_date: dates.cancel_date,
      book_date: null, dept_raw: null, dept_code: null, division_code: null,
      store_raw: null, store_code: null, terms_raw: termsRaw, terms_code: null,
      ship_via_code: null, warehouse_code: null,
      raw: {
        reference_po: oneLine.match(/Reference\s+PO\s+([A-Z0-9]+)/i)?.[1] || null,
        buyer: oneLine.match(/Buyer\s+([A-Z][A-Z\s.'-]+?)\s+Vendor\b/i)?.[1]?.trim() || null,
        ticket_option: oneLine.match(/Ticket\s+Option\s+(.+?)\s+Vendor\s+Style/i)?.[1]?.trim() || null,
        vendor_no: extractVendorNumber(oneLine),
        note: 'Raw Citi extraction only. Final A2000 codes are resolved exclusively from official masters.'
      }
    },
    lines,
    totals: { qty: calculatedQty || parsedTotalQty || null, amount: calculatedAmount || parsedTotalAmount || null, pdf_qty: parsedTotalQty || null, pdf_amount: parsedTotalAmount || null },
    conflicts
  };
}
