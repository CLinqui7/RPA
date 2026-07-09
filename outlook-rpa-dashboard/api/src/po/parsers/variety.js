import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function parseVariety({ text }) {
  const oneLine = compactText(text);
  const orderNo = oneLine.match(/PURCHASE\s+ORDER\s*(?:#|NO\.?|NUMBER)?\s*(\d{6,10})/i)?.[1]
    || oneLine.match(/P\.O\.\s*#?\s*(\d{6,10})/i)?.[1]
    || null;
  const orderDate = oneLine.match(/ENTRY\s+DATE\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]
    || oneLine.match(/ORDER\s+DATE\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]
    || null;
  const shipDate = oneLine.match(/SHIP\s+DATE\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const cancelDate = oneLine.match(/CANCEL\s+DATE\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const terms = oneLine.match(/INVOICE\s+TERMS\s*:?\s*(.+?)(?:\s+FREIGHT:|\s+FOB:|\s+DEPT\b|\s+BUYER\b|\s+VW SKU\b|$)/i)?.[1]?.trim() || null;
  const customerRaw = clean(oneLine.match(/\b(VARIETY\s+WHOLESALERS,?\s+INC)\b/i)?.[1]) || null;
  const storeRaw = clean(oneLine.match(/SHIP\s+TO.*?#\s*(\d{3,6})/i)?.[1])
    || clean(oneLine.match(/\b\d+\s+[A-Z][A-Z ]+\s+#\s*(\d{3,6})\b/i)?.[1])
    || null;

  const lines = [];
  const rowPattern = /(\d{5,8})\s+([A-Z0-9]+(?:-[A-Z0-9]+){1,4})\s+(.+?)\s+([\d,]+)\s+(EA|EACH|PC|PCS)\s+(\d+(?:\.\d{2,3})?)\s+([\d,]+(?:\.\d{2})?)/gi;
  let match;
  while ((match = rowPattern.exec(oneLine)) !== null) {
    const qtyRaw = normalizeInteger(String(match[4]).replace(/,/g, ''));
    const uomRaw = clean(match[5]).toUpperCase();
    lines.push({
      line_no: lines.length + 1,
      customer_sku: match[1],
      ticket_sku: null,
      upc: null,
      style_raw: match[2],
      style_code: null,
      color_raw: null,
      color_code: null,
      description: clean(match[3]) || null,
      sales_price: normalizeMoney(match[6]),
      qty_total: qtyRaw,
      warehouse_code: null,
      raw: {
        source: 'variety_row_regex_v14_master_only',
        style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED',
        trailing_style_suffix_semantics: 'NON_A2000_CUSTOMER_SUFFIX_CANDIDATE',
        trailing_style_suffix_color_semantics: 'PREFIX_OF_OFFICIAL_COLOR_CODE',
        quantity_raw: qtyRaw,
        quantity_semantics: ['EA', 'EACH', 'PC', 'PCS'].includes(uomRaw) ? 'EACH' : 'UNSPECIFIED_COUNT',
        quantity_uom_raw: uomRaw,
        ext_cost: normalizeMoney(String(match[7]).replace(/,/g, '')),
        matched_text: match[0]
      }
    });
  }

  return {
    parser: 'variety',
    document_family: 'variety_wholesalers_purchase_order',
    layout_version: 'variety_row_regex_v14_master_only',
    document_identity: { legal_entity_raw: customerRaw, brand_raw: null, customer_candidate: 'VARIETYWHO', customer_candidate_source: 'document_family', a2000_customer_code: null },
    confidence: lines.length ? 0.9 : 0.45,
    header: {
      customer_raw: customerRaw, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDate), start_date: normalizeDate(shipDate), cancel_date: normalizeDate(cancelDate),
      book_date: null, dept_raw: oneLine.match(/DEPT\s+(\d+)/i)?.[1] || null, dept_code: null, division_code: null,
      store_raw: storeRaw, store_code: null, terms_raw: terms, terms_code: null,
      ship_via_code: null, warehouse_code: null, raw: {}
    },
    lines,
    totals: { qty: lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null },
    conflicts: []
  };
}
