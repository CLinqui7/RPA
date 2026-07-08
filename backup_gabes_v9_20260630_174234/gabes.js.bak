import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function firstDatePairAfterCollect(oneLine) {
  const m = oneLine.match(/Collect\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return { shipDate: m?.[1] || null, cancelDate: m?.[2] || null };
}

export function parseGabes({ text }) {
  const oneLine = compactText(text);
  const po = oneLine.match(/\b(\d{3}-\d{10}\s*LP)\b/i)?.[1]?.replace(/\s+/g, ' ') || null;
  const orderDate = oneLine.match(/Order Date\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const dates = firstDatePairAfterCollect(oneLine);
  const terms = oneLine.match(/\b(NET\s*\d+\s*DAYS)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
  const vendorId = oneLine.match(/Vendor ID:\s*([A-Z0-9]+)/i)?.[1] || null;

  const rowsSection = oneLine.split(/Internal Item #|ItemSKUPKQtyStyleDescriptionCostCost/i).slice(-1)[0] || oneLine;
  const rowPattern = /(\d{4}-\d{4}-\d{2}-\d-\d)\s*(\d{10})\s*(\d)\s*(\d+)\s*([A-Z0-9]+-\d{2}-[A-Z0-9]{3})\s*(.+?)\s*\$\s*(\d+(?:\.\d{2})?)\s*\$\s*([\d,]+\.\d{2})/g;
  const lines = [];
  let match;
  let lineNo = 1;
  while ((match = rowPattern.exec(rowsSection)) !== null) {
    const descriptionWithColor = match[6].replace(/\s+/g, ' ').trim();
    const colorToken = descriptionWithColor.match(/^([A-Z]{2,5})\b/)?.[1] || null;
    const description = colorToken ? descriptionWithColor.replace(/^([A-Z]{2,5})\s+/, '').trim() : descriptionWithColor;
    const gtinWindow = rowsSection.slice(rowPattern.lastIndex, rowPattern.lastIndex + 80);
    const gtin = gtinWindow.match(/RO\s*GTIN\s*(\d{11,14})/i)?.[1] || null;
    lines.push({
      line_no: lineNo++,
      customer_sku: match[1],
      ticket_sku: match[2],
      style_raw: match[5],
      style_code: null,
      color_raw: colorToken,
      color_code: null,
      size_raw: null,
      size_code: null,
      description,
      sales_price: normalizeMoney(match[7]),
      qty_total: normalizeInteger(match[4]),
      qty_sz1: normalizeInteger(match[4]),
      warehouse_code: null,
      raw: { source: 'gabes_compressed_row_regex_v9', cs_pk: match[3], ext_cost: normalizeMoney(match[8]), gtin, matched_text: match[0] }
    });
  }

  return {
    parser: 'gabes',
    confidence: lines.length ? 0.92 : 0.55,
    header: {
      customer_raw: "Gabe's",
      customer_code: null,
      order_no: po,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(dates.shipDate),
      cancel_date: normalizeDate(dates.cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: 'Morgantown DC',
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: { vendorId }
    },
    lines,
    totals: {
      qty: normalizeInteger(oneLine.match(/Total\s*(\d+)\s*\$\s*[\d,]+\.\d{2}/i)?.[1]),
      amount: normalizeMoney(oneLine.match(/Total\s*\d+\s*\$\s*([\d,]+\.\d{2})/i)?.[1])
    },
    conflicts: []
  };
}
