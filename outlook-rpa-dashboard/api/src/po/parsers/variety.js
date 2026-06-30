import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

export function parseVariety({ text }) {
  const oneLine = compactText(text);
  const orderNo = oneLine.match(/PURCHASE\s+ORDER\s*(?:#|NO\.?|NUMBER)?\s*(\d{6,10})/i)?.[1]
    || oneLine.match(/P\.O\.\s*#?\s*(\d{6,10})/i)?.[1]
    || null;
  const orderDate = oneLine.match(/ENTRY\s+DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]
    || oneLine.match(/ORDER\s+DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]
    || null;
  const shipDate = oneLine.match(/SHIP\s+DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const cancelDate = oneLine.match(/CANCEL\s+DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const terms = oneLine.match(/INVOICE\s+TERMS\s*([^\n]+?)(?:FOB|DEPT|BUYER|VW SKU|$)/i)?.[1]?.trim() || null;

  const lines = [];
  const rowPattern = /(\d{5,8})\s+([A-Z0-9]+(?:-[A-Z0-9]+){1,4})\s+(.+?)\s+(\d+)\s+(?:EA|EACH|PC|PCS)\s+(\d+(?:\.\d{2,3})?)\s+(\d+(?:\.\d{2})?)/gi;
  let match;
  let lineNo = 1;
  while ((match = rowPattern.exec(oneLine)) !== null) {
    lines.push({
      line_no: lineNo++,
      customer_sku: match[1],
      style_raw: match[2],
      style_code: null,
      color_raw: null,
      color_code: null,
      description: match[3].replace(/\s+/g, ' ').trim(),
      sales_price: normalizeMoney(match[5]),
      qty_total: normalizeInteger(match[4]),
      qty_sz1: normalizeInteger(match[4]),
      warehouse_code: null,
      raw: { source: 'variety_row_regex_v13', ext_cost: normalizeMoney(match[6]), matched_text: match[0] }
    });
  }

  return {
    parser: 'variety',
    confidence: lines.length ? 0.88 : 0.45,
    header: {
      customer_raw: 'Variety Wholesalers',
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(shipDate),
      cancel_date: normalizeDate(cancelDate),
      book_date: null,
      dept_raw: oneLine.match(/DEPT\s*(\d+)/i)?.[1] || null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {}
    },
    lines,
    totals: { qty: lines.reduce((s, l) => s + (l.qty_total || 0), 0) || null },
    conflicts: []
  };
}
