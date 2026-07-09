import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function linesOf(text) {
  return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, ''));
}

function normalizeEnglishDate(value) {
  const raw = clean(value);
  if (!raw) return null;
  const slash = normalizeDate(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(slash)) return slash;
  const match = raw.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) return raw;
  const months = { JANUARY:1, FEBRUARY:2, MARCH:3, APRIL:4, MAY:5, JUNE:6, JULY:7, AUGUST:8, SEPTEMBER:9, OCTOBER:10, NOVEMBER:11, DECEMBER:12 };
  const month = months[match[1].toUpperCase()];
  if (!month) return raw;
  return `${match[3]}-${String(month).padStart(2,'0')}-${String(Number(match[2])).padStart(2,'0')}`;
}

function dateOnly(value) {
  return clean(value).match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/)?.[0] || null;
}

function parseShipTo(rawLines) {
  const index = rawLines.findIndex((line) => /\bVENDOR\b/i.test(line) && /\bSHIP TO\b/i.test(line));
  if (index < 0) return null;
  const rightParts = rawLines.slice(index + 1, index + 7).map((line) => {
    const source = String(line || '');
    const pieces = source.split(/\s{8,}/).map(clean).filter(Boolean);
    if (pieces.length >= 2) return pieces[pieces.length - 1];
    if (/^\s{40,}\S/.test(source)) return clean(source);
    return null;
  }).filter(Boolean);
  const cityStatePostal = rightParts.find((value) => /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(value)) || null;
  const cityMatch = cityStatePostal?.match(/^(.+?),?\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  const address1 = rightParts.find((value) => /^\d+\s+/.test(value)) || null;
  return {
    semantics: 'SHIP_TO',
    name_raw: rightParts.find((value) => !/^ATTN:/i.test(value) && !/^\d+\s+/.test(value) && value !== cityStatePostal && !/United States/i.test(value) && !/PICKUP DATE/i.test(value)) || null,
    contact_raw: rightParts.find((value) => /^ATTN:/i.test(value)) || null,
    address1_raw: address1,
    city_raw: clean(cityMatch?.[1]) || null,
    state_raw: clean(cityMatch?.[2]).toUpperCase() || null,
    postal_raw: clean(cityMatch?.[3]) || null,
    country_raw: rightParts.find((value) => /United States/i.test(value)) || null,
    block_raw: rightParts
  };
}

export function parseIpc({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);
  const legalEntityRaw = clean(oneLine.match(/\b(Integrated Premium Concepts, LLC)\b/i)?.[1]) || null;
  const orderNo = clean(oneLine.match(/\bP\.O\.\s*NO\.\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const orderDateRaw = clean(oneLine.match(/\bDATE\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})\b/i)?.[1]) || null;
  const customerIdRaw = clean(oneLine.match(/\bCUSTOMER ID\s+([A-Z0-9-]+)/i)?.[1]) || null;

  const paymentIndex = rawLines.findIndex((line) => /PAYMENT TERMS/i.test(line) && /SHIPPING TERMS/i.test(line) && /PICKUP DATE/i.test(line));
  const paymentValueLine = paymentIndex >= 0 ? rawLines.slice(paymentIndex + 1, paymentIndex + 4).find((line) => clean(line)) || '' : '';
  const paymentParts = String(paymentValueLine).split(/\s{8,}/).map(clean).filter(Boolean);
  const termsRaw = paymentParts[0] || null;
  const shippingTermsRaw = paymentParts[1] || null;
  const pickupDateRaw = dateOnly(paymentParts[2]) || dateOnly(paymentValueLine);
  const instructionPickupDateRaw = clean(oneLine.match(/PLEASE\s+PREPARE\s+FOR\s+PICKUP\s+BY\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]) || null;
  const shipTo = parseShipTo(rawLines);

  const lines = [];
  const itemPattern = /^\s*([\d,.]+)\s+([A-Z0-9][A-Z0-9./-]{2,})\s+(.+?)\s*$/i;
  for (let index = 0; index < rawLines.length; index += 1) {
    const match = rawLines[index].match(itemPattern);
    if (!match || !/^\d/.test(clean(match[1]))) continue;
    const qtyRaw = normalizeMoney(match[1]);
    const itemRaw = clean(match[2]);
    const descriptionRaw = clean(match[3]);
    if (!itemRaw.includes('-')) continue;
    const priceWindow = rawLines.slice(index + 1, index + 4).join(' ');
    const moneyTokens = [...priceWindow.matchAll(/\$?\s*([\d,]+\.\d{2})/g)].map((m) => normalizeMoney(m[1])).filter((v) => v !== null);
    const unitPriceRaw = moneyTokens[0] ?? null;
    const lineTotalRaw = moneyTokens[1] ?? null;
    lines.push({
      line_no: lines.length + 1, customer_sku: null, ticket_sku: null, upc: null,
      style_raw: itemRaw, style_code: null, color_raw: null, color_code: null,
      size_raw: null, size_code: null, description: descriptionRaw || null,
      sales_price: unitPriceRaw, list_price: null,
      qty_total: qtyRaw === null ? null : normalizeInteger(qtyRaw), warehouse_code: null,
      raw: {
        source: 'ipc_purchase_order_v1', item_number_raw: itemRaw,
        style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED', quantity_raw: qtyRaw,
        quantity_semantics: 'ORDERED_UNITS', quantity_uom_raw: 'QTY',
        description_raw: descriptionRaw || null, unit_price_raw: unitPriceRaw,
        line_total_raw: lineTotalRaw, unit_price_label_raw: 'UNIT PRICE', matched_text: rawLines[index].trim()
      }
    });
  }

  const conflicts = [];
  const normalizedPickup = normalizeDate(pickupDateRaw);
  const normalizedInstructionPickup = normalizeDate(instructionPickupDateRaw);
  if (normalizedPickup && normalizedInstructionPickup && normalizedPickup !== normalizedInstructionPickup) {
    conflicts.push({ field:'pickup_date', code:'source_date_conflict', severity:'high', blocking:true, message:'Printed PICKUP DATE conflicts with pickup date in special instructions.', pickup_date_raw:pickupDateRaw, instruction_pickup_date_raw:instructionPickupDateRaw });
  }
  const calculatedQty = lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (Number(line.raw?.line_total_raw) || 0), 0) || null;
  const printedSubtotal = normalizeMoney(oneLine.match(/\bSUBTOTAL\s*\$\s*([\d,]+(?:\.\d{2})?)/i)?.[1]);
  if (printedSubtotal !== null && calculatedAmount !== null && Math.abs(printedSubtotal - calculatedAmount) > 0.01) {
    conflicts.push({ field:'totals.amount', code:'printed_total_mismatch', severity:'high', blocking:true, message:'Printed subtotal does not match extracted line total sum.', printed:printedSubtotal, extracted:calculatedAmount });
  }

  return {
    parser:'ipc', document_family:'ipc_purchase_order', layout_version:'ipc_purchase_order_v1',
    document_identity:{ legal_entity_raw:legalEntityRaw, brand_raw:clean(oneLine.match(/\b(IPC)\b/i)?.[1]) || null, customer_candidate:'IPC', customer_candidate_source:'document_family', a2000_customer_code:null },
    confidence: orderNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.45,
    header:{ customer_raw:legalEntityRaw, customer_code:null, order_no:orderNo, order_date:normalizeEnglishDate(orderDateRaw), start_date:normalizeDate(pickupDateRaw), cancel_date:null, book_date:null, dept_raw:null, dept_code:null, division_code:null, store_raw:null, store_code:null, terms_raw:termsRaw, terms_code:null, ship_via_code:null, warehouse_code:null, raw:{ legal_entity_raw:legalEntityRaw, customer_id_raw:customerIdRaw, order_date_raw:orderDateRaw, payment_terms_raw:termsRaw, shipping_terms_raw:shippingTermsRaw, pickup_date_raw:pickupDateRaw, instruction_pickup_date_raw:instructionPickupDateRaw, ship_to:shipTo } },
    lines, totals:{ qty:calculatedQty, amount:calculatedAmount, printed_amount_raw:printedSubtotal }, conflicts
  };
}
