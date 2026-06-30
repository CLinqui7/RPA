import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

export function parseSpencers({ text }) {
  const oneLine = compactText(text);
  const orderNo = oneLine.match(/ACC\s+(\d{5,8})\b/i)?.[1]
    || oneLine.match(/\b(\d{5,8})\s+\d{6}\s+AMERICAN EXCHANGE/i)?.[1]
    || null;
  const orderDate = oneLine.match(/^(?:\s*)?(\d{1,2}\/\d{1,2}\/\d{2})\b/)?.[1]
    || oneLine.match(/\b(\d{1,2}\/\d{1,2}\/\d{2})\s+1\s+1\b/)?.[1]
    || null;
  const dates = oneLine.match(/ORDER IS CANCELLED IF NOT DELIVERED BY\s*(\d{1,2}\/\d{1,2}\/\d{2,4}).*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+PPD/i);
  const terms = oneLine.match(/\b(NET\s+\d+\s+DAYS\s+OF\s+ROG)\b/i)?.[1]?.toUpperCase() || null;

  const lines = [];
  const rowPattern = /(\d{8})\s+([A-Z0-9-]+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{2})?)\s+(\d+(?:\.\d{2})?)\s+VENDOR TO TICKET ITEM\s+-\s+USD\s*\$\s*(\d+(?:\.\d{2})?).*?UPC\s*(\d{11,14})/gi;
  let match;
  let lineNo = 1;
  while ((match = rowPattern.exec(oneLine)) !== null) {
    lines.push({
      line_no: lineNo++,
      customer_sku: match[1],
      upc: match[10],
      style_raw: match[2],
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: match[3].replace(/\s+/g, ' ').trim(),
      sales_price: normalizeMoney(match[7]),
      list_price: normalizeMoney(match[9]),
      qty_total: normalizeInteger(match[6]),
      qty_sz1: normalizeInteger(match[6]),
      warehouse_code: null,
      raw: {
        source: 'spencers_row_regex_v9',
        inner_pack: normalizeInteger(match[4]),
        master_pack: normalizeInteger(match[5]),
        ext_cost: normalizeMoney(match[8]),
        matched_text: match[0]
      }
    });
  }

  return {
    parser: 'spencers',
    confidence: lines.length ? 0.9 : 0.55,
    header: {
      customer_raw: "Spencer's",
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(dates?.[2]),
      cancel_date: normalizeDate(dates?.[1] || dates?.[3]),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: 'Spencer Gifts LLC',
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {}
    },
    lines,
    totals: {
      qty: lines.reduce((sum, line) => sum + (line.qty_total || 0), 0) || null,
      amount: lines.reduce((sum, line) => sum + ((line.sales_price || 0) * (line.qty_total || 0)), 0) || null
    },
    conflicts: []
  };
}
