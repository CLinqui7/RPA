import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}


function parseShipTo(oneLine) {
  const match = oneLine.match(/SPENCER\s+GIFTS\s+LLC[\s\S]{0,180}?(\d+\s+NATIONS\s+FORD\s+ROAD)[\s\S]{0,180}?(CHARLOTTE),\s*NC\s+(\d{5})/i);
  if (!match) return null;
  return {
    semantics: 'SHIP_TO',
    name_raw: 'SPENCER GIFTS LLC',
    address1_raw: clean(match[1]),
    city_raw: clean(match[2]),
    state_raw: 'NC',
    postal_raw: clean(match[3]),
    block_raw: clean(match[0])
  };
}

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
  const customerRaw = clean(oneLine.match(/\b(Spencer\s+Gifts(?:\s+LLC)?)\b/i)?.[1]) || null;
  const shipTo = parseShipTo(oneLine);

  const lines = [];
  const rowPattern = /(\d{8})\s+([A-Z0-9-]+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d{2})?)\s+(\d+(?:\.\d{2})?)\s+VENDOR TO TICKET ITEM\s+-\s+USD\s*\$\s*(\d+(?:\.\d{2})?).*?UPC\s*(\d{11,14})/gi;
  let match;
  while ((match = rowPattern.exec(oneLine)) !== null) {
    const upcRaw = match[10];
    lines.push({
      line_no: lines.length + 1,
      customer_sku: match[1],
      ticket_sku: null,
      upc: upcRaw,
      style_raw: match[2],
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: clean(match[3]) || null,
      sales_price: normalizeMoney(match[7]),
      list_price: normalizeMoney(match[9]),
      qty_total: normalizeInteger(match[6]),
      warehouse_code: null,
      raw: {
        source: 'spencers_row_regex_v10_master_only',
        customer_upc_raw: upcRaw,
        upc_semantics: 'UPC',
        style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED',
        quantity_raw: normalizeInteger(match[6]),
        quantity_semantics: 'EACH',
        quantity_uom_raw: null,
        inner_pack: normalizeInteger(match[4]),
        master_pack: normalizeInteger(match[5]),
        ext_cost: normalizeMoney(match[8]),
        matched_text: match[0]
      }
    });
  }

  return {
    parser: 'spencers',
    document_family: 'spencers_purchase_order',
    layout_version: 'spencers_row_regex_v10_master_only',
    document_identity: { legal_entity_raw: customerRaw, brand_raw: customerRaw, customer_candidate: 'SPENCER', customer_candidate_source: 'document_family', a2000_customer_code: null },
    confidence: lines.length ? 0.9 : 0.55,
    header: {
      customer_raw: customerRaw, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDate), start_date: normalizeDate(dates?.[2]), cancel_date: normalizeDate(dates?.[1] || dates?.[3]),
      book_date: null, dept_raw: null, dept_code: null, division_code: null,
      store_raw: null, store_code: null, terms_raw: terms, terms_code: null,
      ship_via_code: null, warehouse_code: null, raw: { ship_to: shipTo }
    },
    lines,
    totals: {
      qty: lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null,
      amount: lines.reduce((sum, line) => sum + (Number(line.sales_price) || 0) * (Number(line.qty_total) || 0), 0) || null
    },
    conflicts: []
  };
}
