import { normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

const knownColors = [
  'BLACK-OFF BLACK', 'WHITE', 'PINK', 'YELLOW', 'BLACK', 'BLUE', 'RED', 'GREEN', 'BROWN', 'MULTI'
];

function splitDescriptionAndColor(value) {
  const rest = String(value || '').trim();
  for (const color of knownColors) {
    if (rest.toUpperCase().endsWith(color)) {
      return {
        description: rest.slice(0, rest.length - color.length).trim(),
        color_raw: color
      };
    }
  }
  const parts = rest.split(/\s+/);
  return { description: parts.slice(0, -1).join(' '), color_raw: parts.at(-1) || null };
}

export function parseCitiTrends({ text }) {
  const linesText = String(text || '').replace(/\u00a0/g, ' ').split(/\n+/).map(x => x.trim()).filter(Boolean);
  const joined = linesText.join(' ');
  const po = joined.match(/Purchase Order\s+Order Date\s+Terms Buyer\s+(\d+)/i)?.[1]
    || joined.match(/Purchase Order\s+(\d{6,})/i)?.[1]
    || null;
  const dateBlock = joined.match(/Ship On Cancel After\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const terms = joined.match(/\b(NET\s+\d+\s+DAYS\s+ROG)\b/i)?.[1]?.toUpperCase() || null;

  const orderLines = [];
  for (let i = 0; i < linesText.length - 1; i++) {
    const m = linesText[i].match(/^([A-Z]{2}\d{3}-[A-Z0-9]+)\s+(.+)$/);
    const next = linesText[i + 1];
    const detail = next.match(/(\d{4}-\d{6}-\d{7}-\d{4}-\d{5})\s+(\d{12,14})\s+(\d+(?:\.\d{4})?)\s+(-|[A-Z0-9]+)\s+(\d+)/);
    if (m && detail) {
      const split = splitDescriptionAndColor(m[2]);
      orderLines.push({
        line_no: orderLines.length + 1,
        customer_sku: detail[1],
        upc: detail[2],
        style_raw: m[1],
        style_code: null,
        color_raw: split.color_raw,
        color_code: null,
        size_raw: detail[4],
        size_code: null,
        description: split.description,
        sales_price: normalizeMoney(detail[3]),
        qty_total: normalizeInteger(detail[5]),
        qty_sz1: normalizeInteger(detail[5]),
        warehouse_code: null,
        raw: { source: 'cititrends_two_line_pattern', style_line: linesText[i], detail_line: next }
      });
    }
  }

  return {
    parser: 'cititrends',
    confidence: orderLines.length ? 0.88 : 0.5,
    header: {
      customer_raw: 'Citi Trends',
      customer_code: null,
      order_no: po,
      order_date: normalizeDate(dateBlock?.[1]),
      start_date: normalizeDate(dateBlock?.[2]),
      cancel_date: normalizeDate(dateBlock?.[3]),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: { reference_po: joined.match(/Reference PO\s+([A-Z0-9]+)/i)?.[1] || null }
    },
    lines: orderLines,
    totals: {
      qty: normalizeInteger(joined.match(/Total\s+\$[\d,]+\.\d{2}\s+([\d,]+)/i)?.[1]),
      amount: normalizeMoney(joined.match(/Total\s+\$([\d,]+\.\d{2})/i)?.[1])
    },
    conflicts: []
  };
}
