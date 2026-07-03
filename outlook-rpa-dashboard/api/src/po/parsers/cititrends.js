import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

const KNOWN_COLORS = [
  'BLACK-OFF BLACK',
  'PINK/BLACK',
  'RED/BLACK',
  'OFF BLACK',
  'WHITE',
  'BLACK',
  'PINK',
  'YELLOW',
  'BLUE',
  'RED',
  'GREEN',
  'BROWN',
  'MULTI',
  'NATURAL',
  'GREY',
  'GRAY',
  'PURPLE',
  'ORANGE',
  'SILVER',
  'GOLD'
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

  for (const color of KNOWN_COLORS) {
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

  // Citi vendor style can be short like SENA or longer like KS306-S9962.
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

  // Layout text usually gives: SKU UPC MSRP COST SIZE QTY
  // pdf-parse may give only: SKU UPC COST SIZE QTY. MSRP then stays null.
  const detail = value.match(/(\d{4}-\d{6}-\d{7}-\d{4}-\d{5})\s+(\d{11,14})(?:\s+(\d+(?:\.\d{2})))?\s+(\d+(?:\.\d{2,4}))\s+(-|[A-Z0-9.\/\-]+)\s+([\d,]+)/i);
  if (!detail) return null;

  return {
    customer_sku: detail[1],
    upc: detail[2],
    ticket_sku: detail[2],
    list_price: money(detail[3]),
    sales_price: money(detail[4]),
    size_raw: detail[5],
    qty_total: int(detail[6]),
    qty_sz1: int(detail[6]),
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
  if (!next) return null;
  if (/^\d+\s+PAIRS\b/i.test(next)) return next;
  return null;
}


function deriveCitiStyleCode(styleRaw) {
  const raw = cleanLine(styleRaw).toUpperCase();
  if (!raw) return null;

  // Document-derived Citi rule confirmed by the user for SENA:
  // PDF prints vendor/customer style "SENA"; A2000 style is "11SENAL".
  // This is a style naming rule, not an order-specific/customer/store hardcode.
  if (raw === 'SENA') return '11SENAL';

  // For all other Citi styles, do NOT invent the internal A2000 style.
  // Add future confirmed rules here or load them from a style master/mapping table.
  return null;
}

function extractItems(text) {
  const lines = getLines(text);
  const tableLines = extractBetweenTableMarkers(lines);
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
      ticket_sku: detail.ticket_sku,
      upc: detail.upc,

      // IMPORTANT: this is the vendor/customer style printed on the Citi PO.
      // It is NOT guaranteed to be the internal A2000 STYLE. Master enrichment may fill style_code later.
      vendor_style_raw: style.vendor_style_raw || null,
      style_raw: style.style_raw || null,
      style_code: null,

      description: style.description || null,
      color_raw: style.color_raw || null,
      color_code: null,
      size_raw: detail.size_raw,
      size_code: detail.size_raw === '-' ? 'PC' : null,
      list_price: detail.list_price,
      sales_price: detail.sales_price,
      qty_total: detail.qty_total,
      qty_sz1: detail.qty_sz1,
      warehouse_code: null,
      raw: {
        source: 'cititrends_table_v3_pdf_only',
        style_line: style.source_line || null,
        detail_line: detail.source_line,
        note: findNextNote(tableLines, i),
        pdf_qty_total: detail.qty_total,
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
  // Most reliable layout: Order Date <date> Ship On <date> Cancel After <date>
  let match = oneLine.match(/Order\s+Date\s+Ship\s+On\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (!match) {
    match = oneLine.match(/Order\s+Date\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+Ship\s+On\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  }
  if (!match) {
    match = oneLine.match(/Ship\s+On\s+Cancel\s+After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  }

  return {
    order_date: normalizeDate(match?.[1]),
    start_date: normalizeDate(match?.[2]),
    cancel_date: normalizeDate(match?.[3])
  };
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
  const termsRaw = oneLine.match(/\b(NET\s+\d+\s+DAYS\s+ROG)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
  const dates = extractDates(oneLine);
  const totalAmount = oneLine.match(/Total\s+\$\s*([\d,]+\.\d{2})/i)?.[1] || null;
  const totalQty = oneLine.match(/Total\s+\$\s*[\d,]+\.\d{2}\s+([\d,]+)/i)?.[1] || null;
  const parsedTotalQty = int(totalQty);
  const parsedTotalAmount = normalizeMoney(totalAmount);

  const header = {
    customer_raw: 'Citi Trends',
    customer_code: 'CITI',
    order_no: orderNo,
    order_date: dates.order_date,
    start_date: dates.start_date,
    cancel_date: dates.cancel_date,
    book_date: dates.order_date,
    dept_raw: null,
    dept_code: null,

    // Strict PDF-only mode: do not infer A2000-only fields from screenshots or prior examples.
    // Citi PO does not print Store 4, Div MJ/X, Header W/H HT, or operational qty 1200.
    division_code: null,
    store_raw: null,
    store_code: null,
    terms_raw: termsRaw,
    terms_code: termsRaw ? 'X6' : null,
    ship_via_code: null,
    warehouse_code: null,
    raw: {
      reference_po: oneLine.match(/Reference\s+PO\s+([A-Z0-9]+)/i)?.[1] || null,
      buyer: oneLine.match(/Buyer\s+([A-Z][A-Z\s.'-]+?)\s+Vendor\b/i)?.[1]?.trim() || null,
      ticket_option: oneLine.match(/Ticket\s+Option\s+(.+?)\s+Vendor\s+Style/i)?.[1]?.trim() || null,
      vendor_no: extractVendorNumber(oneLine),
      note: 'Strict PDF-only Citi extraction. Store/division/warehouse/A2000 color are not present on the PO PDF and must remain null unless supplied by an approved mapping source.'
    }
  };

  const calculatedQty = lines.reduce((acc, line) => acc + Number(line.qty_total || 0), 0);
  const calculatedAmount = lines.reduce((acc, line) => acc + Number(line.qty_total || 0) * Number(line.sales_price || 0), 0);
  const conflicts = [];

  if (parsedTotalQty && calculatedQty && parsedTotalQty !== calculatedQty) {
    conflicts.push({
      field: 'total_qty',
      pdf_total: parsedTotalQty,
      calculated_from_lines: calculatedQty,
      message: 'Citi PDF total quantity differs from extracted line quantity.'
    });
  }

  return {
    parser: 'cititrends',
    confidence: lines.length ? 0.95 : 0.45,
    header,
    lines,
    totals: {
      qty: calculatedQty || parsedTotalQty || null,
      amount: calculatedAmount || parsedTotalAmount || null,
      pdf_qty: parsedTotalQty || null,
      pdf_amount: parsedTotalAmount || null
    },
    conflicts
  };
}
