import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function linesOf(text) { return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, '')); }

function parseShipTo(rawLines) {
  const first = rawLines.findIndex((line) => /Bill To:/i.test(line) && /Ship To:/i.test(line));
  if (first < 0) return null;

  const firstLine = String(rawLines[first] || '');
  const address1Raw = clean(firstLine.match(/Ship To:\s*(.+?)(?:\s{8,}Ship via|$)/i)?.[1]) || null;
  let neighborhoodRaw = null;
  let cityRaw = null;
  let stateRaw = null;
  let postalRaw = null;
  const block = [];

  for (const rawLine of rawLines.slice(first, first + 6)) {
    const source = String(rawLine || '');
    const cityMatches = [...source.matchAll(/\b([A-Za-z .'-]+),\s*(PR)\s+(\d{5}(?:-\d{4})?)\b/gi)];
    const cityMatch = cityMatches.find((match) => /Vega\s+Alta/i.test(match[1]));
    if (cityMatch) {
      cityRaw = clean(cityMatch[1]);
      stateRaw = clean(cityMatch[2]).toUpperCase();
      postalRaw = clean(cityMatch[3]);
    }
    const neighborhoodMatch = source.match(/\b(Barrio\s+Sabana\s+Hoyos)\b/i);
    if (neighborhoodMatch) neighborhoodRaw = clean(neighborhoodMatch[1]);
    if (clean(source)) block.push(clean(source));
  }

  return {
    semantics: 'SHIP_TO',
    name_raw: 'Me Salve Inc.',
    address1_raw: address1Raw,
    address2_raw: neighborhoodRaw,
    city_raw: cityRaw,
    state_raw: stateRaw,
    postal_raw: postalRaw,
    block_raw: block
  };
}

export function parseMeSalve({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);
  const legalEntityRaw = clean(oneLine.match(/Bill To:\s*(Me Salve Inc\.)/i)?.[1]) || null;
  const orderNo = clean(oneLine.match(/Order Number:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const vendorNoRaw = clean(oneLine.match(/Vendor No:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const vendorNameRaw = clean(oneLine.match(/Vendor Name:\s*(.+?)\s+Buyer:/i)?.[1]) || null;
  const buyerRaw = clean(oneLine.match(/Buyer:\s*(.+?)\s+Order Date:/i)?.[1]) || null;
  const orderDateRaw = clean(oneLine.match(/Order Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]) || null;
  const shipDateRaw = clean(oneLine.match(/Ship Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]) || null;
  const cancelDateRaw = clean(oneLine.match(/Cancel Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]) || null;
  const termsRaw = clean(oneLine.match(/Terms:\s*(NET\s*\d+)/i)?.[1]) || null;
  const expectedDeliveryRaw = clean(oneLine.match(/Expected Delivery Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1]) || null;
  const shipTo = parseShipTo(rawLines);

  const lines = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    if (!/^\s*[A-Z0-9][A-Z0-9./-]{4,}\s{2,}/i.test(rawLine)) continue;
    const cols = String(rawLine).trim().split(/\s{2,}/).map(clean).filter(Boolean);
    if (cols.length < 14 || !/^\d[\d,]*$/.test(cols[2] || '') || !/^(each|case|pc|pcs)$/i.test(cols[3] || '')) continue;
    const vendorStyleRaw = cols[0];
    const descriptionParts = [cols[1]];
    for (let cursor = index + 1; cursor < rawLines.length; cursor += 1) {
      const continuation = rawLines[cursor];
      if (/^\s*[A-Z0-9][A-Z0-9./-]{4,}\s{2,}/i.test(continuation) || /^\s*Grand Total:/i.test(continuation)) break;
      const value = clean(continuation);
      if (value && /^\s{10,}/.test(continuation) && !/Shipping Department Instructions/i.test(value)) descriptionParts.push(value);
    }
    const qtyRaw = normalizeInteger(cols[2]);
    const uomRaw = clean(cols[3]);
    const innerPackRaw = normalizeMoney(cols[4]);
    const casePackRaw = normalizeMoney(cols[5]);
    const costRaw = normalizeMoney(cols[6]);
    const totalCostRaw = normalizeMoney(cols[7]);
    const deptRaw = clean(cols[8]);
    const subDeptRaw = clean(cols[9]);
    const classRaw = clean(cols[10]);
    const subClassRaw = clean(cols[11]);
    const colorRaw = clean(cols[12]);
    const sizeRaw = clean(cols[13]);
    lines.push({
      line_no: lines.length + 1,
      customer_sku: null,
      ticket_sku: null,
      upc: null,
      style_raw: vendorStyleRaw,
      style_code: null,
      color_raw: colorRaw,
      color_code: null,
      size_raw: sizeRaw,
      size_code: null,
      description: clean(descriptionParts.join(' ')) || null,
      sales_price: costRaw,
      list_price: null,
      qty_total: qtyRaw,
      warehouse_code: null,
      raw: {
        source: 'mesalve_purchase_order_v1',
        vendor_style_raw: vendorStyleRaw,
        style_resolution_hint: 'EXACT_MASTER_STYLE_NORMALIZED',
        description_raw: clean(descriptionParts.join(' ')) || null,
        color_raw: colorRaw,
        size_raw: sizeRaw,
        quantity_raw: qtyRaw,
        quantity_semantics: /^each$/i.test(uomRaw) ? 'EACH' : uomRaw.toUpperCase(),
        quantity_uom_raw: uomRaw,
        inner_pack_raw: innerPackRaw,
        case_pack_raw: casePackRaw,
        cost_raw: costRaw,
        total_cost_raw: totalCostRaw,
        dept_raw: deptRaw,
        sub_dept_raw: subDeptRaw,
        class_raw: classRaw,
        sub_class_raw: subClassRaw,
        printed_color_is_customer_classification: true,
        description_color_semantics: 'DESCRIPTION_COLOR_WORDS',
        color_code_format_preference: /^solid$/i.test(colorRaw) ? 'NUMERIC_FOR_SOLID' : /pack/i.test(sizeRaw) ? 'ALPHA_FOR_PREPACK_IF_SEMANTIC_DUPLICATE' : null,
        matched_text: clean(rawLine)
      }
    });
  }

  const printedQty = normalizeInteger(oneLine.match(/Grand Total:\s*([\d,]+)/i)?.[1]);
  const printedAmount = normalizeMoney(oneLine.match(/Grand Total:\s*[\d,]+\s+([\d,]+\.\d{4})/i)?.[1]);
  const calculatedQty = lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (Number(line.raw?.total_cost_raw) || 0), 0) || null;
  const conflicts = [];
  if (printedQty !== null && calculatedQty !== null && printedQty !== calculatedQty) conflicts.push({ field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Me Salve Grand Total quantity does not match extracted line quantities.', printed: printedQty, extracted: calculatedQty });
  if (printedAmount !== null && calculatedAmount !== null && Math.abs(printedAmount - calculatedAmount) > 0.01) conflicts.push({ field: 'totals.amount', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Me Salve Grand Total amount does not match extracted line total costs.', printed: printedAmount, extracted: calculatedAmount });

  return {
    parser: 'mesalve', document_family: 'mesalve_purchase_order', layout_version: 'mesalve_po_v1',
    document_identity: { legal_entity_raw: legalEntityRaw, brand_raw: clean(oneLine.match(/\b(Me Salve)\b/i)?.[1]) || null, customer_candidate: 'MESALVEINC', customer_candidate_source: 'document_family', a2000_customer_code: null },
    confidence: orderNo && lines.length ? 0.98 : lines.length ? 0.82 : 0.4,
    header: {
      customer_raw: legalEntityRaw, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDateRaw), start_date: normalizeDate(shipDateRaw), cancel_date: normalizeDate(cancelDateRaw), book_date: null,
      dept_raw: null, dept_code: null, division_code: null,
      store_raw: null, store_code: null,
      terms_raw: termsRaw, terms_code: null, ship_via_code: null, warehouse_code: null,
      raw: { vendor_no_raw: vendorNoRaw, vendor_name_raw: vendorNameRaw, buyer_raw: buyerRaw, order_date_raw: orderDateRaw, ship_date_raw: shipDateRaw, cancel_date_raw: cancelDateRaw, expected_delivery_date_raw: expectedDeliveryRaw, terms_raw: termsRaw, ship_to: shipTo }
    },
    lines,
    totals: { qty: calculatedQty, amount: calculatedAmount, printed_qty_raw: printedQty, printed_amount_raw: printedAmount },
    conflicts,
    warnings: []
  };
}
