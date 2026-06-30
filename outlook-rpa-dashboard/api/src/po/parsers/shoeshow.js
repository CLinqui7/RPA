import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function collapseRepeatedLetters(value) {
  // Some Shoe Show PDFs extract as PPPPUUUURRRRCCCCHHHHAAAASSSSEEEE.
  // Collapse 3+ repeated identical characters to one.
  return String(value || '').replace(/(.)\1{2,}/g, '$1');
}

export function parseShoeShow({ text }) {
  const normalizedText = collapseRepeatedLetters(text || '');
  const oneLine = compactText(normalizedText);
  const orderNo = oneLine.match(/PURCHASE\s+ORDER\s*#?\s*(\d{4,10})/i)?.[1]
    || oneLine.match(/P\.O\.\s*#?\s*(\d{4,10})/i)?.[1]
    || null;
  const orderDate = oneLine.match(/ORDER\s+DATE\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const shipDate = oneLine.match(/EX-?FACTORY\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const cancelDate = oneLine.match(/CANCEL\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;

  const styleRaw = oneLine.match(/PATTERN:\s*(?:ED HARDY\s*-\s*)?([A-Z0-9]+-\d{2}-[A-Z0-9]{2,5})/i)?.[1] || null;
  const colorRaw = oneLine.match(/COLOR:\s*([A-Z\/ ]{3,40})/i)?.[1]?.trim() || null;
  const stock = oneLine.match(/STOCK\s*#?\s*(\d{4,10})/i)?.[1] || null;
  const qty = normalizeInteger(oneLine.match(/QUANTITY\s*(\d+)/i)?.[1]);
  const price = normalizeMoney(oneLine.match(/COST\s*(?:\/UNIT)?\s*\$?\s*(\d+(?:\.\d{2})?)/i)?.[1]);
  const desc = oneLine.match(/PATTERN:\s*(.+?)\s+COLOR:/i)?.[1]?.replace(/^ED HARDY\s*-\s*/i, '').trim() || null;

  const lines = styleRaw && qty ? [{
    line_no: 1,
    customer_sku: stock,
    style_raw: styleRaw,
    style_code: null,
    color_raw: colorRaw,
    color_code: null,
    description: desc,
    sales_price: price,
    qty_total: qty,
    qty_sz1: qty,
    warehouse_code: null,
    raw: { source: 'shoeshow_pattern_v13' }
  }] : [];

  return {
    parser: 'shoeshow',
    confidence: lines.length ? 0.86 : 0.45,
    header: {
      customer_raw: 'Shoe Show',
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(shipDate),
      cancel_date: normalizeDate(cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: null,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {}
    },
    lines,
    totals: { qty },
    conflicts: []
  };
}
