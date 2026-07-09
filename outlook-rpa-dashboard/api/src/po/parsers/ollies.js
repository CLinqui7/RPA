import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function linesOf(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''));
}

function matchCompact(oneLine, pattern) {
  return clean(oneLine.match(pattern)?.[1] || '') || null;
}

export function parseOllies({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);

  const legalEntityRaw = matchCompact(oneLine, /^(OLLIE'?S BARGAIN OUTLET, INC\.)(?=\s|$)/i);
  const brandRaw = matchCompact(oneLine, /\b(OLLIE'?S BARGAIN OUTLET)\b/i);
  const orderNo = matchCompact(oneLine, /\bPO#:\s*([A-Z0-9-]+)/i);
  const orderDateRaw = matchCompact(oneLine, /\bOrder Dt:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const startDateRaw = matchCompact(oneLine, /\bStart Ship Dt:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const cancelDateRaw = matchCompact(oneLine, /\bEnd Ship Dt:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const expectedReceiptDateRaw = matchCompact(oneLine, /\bExp Rec Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const termsLine = rawLines.find((line) => /\bTerms:/i.test(line));
  const termsRaw = clean(termsLine?.match(/Terms:\s*(.+?)\s*$/i)?.[1]) || null;
  const shipToMatch = termsLine?.match(/Ship To:\s*(.+?)\s+#(\d{3,6})\s+Terms:/i)
    || oneLine.match(/Ship To:\s*(.+?)\s+#(\d{3,6})\b/i);
  const shipToRaw = clean(shipToMatch?.[1]) || null;
  const shipToNumberRaw = clean(shipToMatch?.[2]) || null;
  const freightRaw = clean(rawLines.find((line) => /^\s*FREIGHT\s+(?:PREPAID|COLLECT)\s*$/i.test(line))?.trim()) || null;
  const fobRaw = clean(rawLines.find((line) => /^\s*FOB:/i.test(line))?.match(/FOB:\s*(.+?)\s*$/i)?.[1]) || null;
  const buyerMatch = oneLine.match(/\bBuyer:\s*([A-Z0-9]+)\s+(.+?)\s+Approved by:/i);
  const buyerCodeRaw = clean(buyerMatch?.[1]) || null;
  const buyerNameRaw = clean(buyerMatch?.[2]) || null;
  const vendorNumberRaw = matchCompact(oneLine, /\bVendor#:\s*([A-Z0-9-]+)/i);

  const rowPattern = /^\s*(\d+)\s+(\d{5,12})\s+(.+?)\s+(\d{11,14})\s+([A-Z0-9][A-Z0-9./-]{1,39})\s+(\d+)\s+([\d,]+)\s+([\d,.]+)\s+([\d,]+(?:\.\d{2})?)\s*$/i;
  const lines = [];

  for (const rawLine of rawLines) {
    const match = rawLine.match(rowPattern);
    if (!match) continue;

    const lineNo = normalizeInteger(match[1]);
    const customerSkuRaw = clean(match[2]);
    const descriptionRaw = clean(match[3]);
    const customerUpcRaw = clean(match[4]);
    const modelRaw = clean(match[5]);
    const casePackRaw = normalizeInteger(match[6]);
    const unitsOrderedRaw = normalizeInteger(match[7]);
    const costRaw = normalizeMoney(match[8]);
    const extCostRaw = normalizeMoney(match[9]);

    lines.push({
      line_no: lineNo,
      customer_sku: customerSkuRaw,
      customer_upc: customerUpcRaw,
      ticket_sku: null,
      upc: customerUpcRaw,
      style_raw: modelRaw,
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: descriptionRaw,
      sales_price: costRaw,
      list_price: null,
      qty_total: unitsOrderedRaw,
      warehouse_code: null,
      raw: {
        source: 'ollies_legacy_table_v1',
        customer_sku_raw: customerSkuRaw,
        customer_upc_raw: customerUpcRaw,
        upc_semantics: 'UPC',
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'UNITS',
        model_no_raw: modelRaw,
        case_pack_raw: casePackRaw,
        units_ordered_raw: unitsOrderedRaw,
        cost_raw: costRaw,
        ext_cost_raw: extCostRaw,
        matched_text: rawLine.trim()
      }
    });
  }

  const printedTotalMatch = oneLine.match(/\bTotal\s*-\s*([\d,]+)\s+([\d,]+(?:\.\d{2})?)\b/i);
  const printedQtyRaw = normalizeInteger(printedTotalMatch?.[1]);
  const printedAmountRaw = normalizeMoney(printedTotalMatch?.[2]);
  const calculatedQty = lines.reduce((sum, line) => sum + (line.qty_total || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (line.raw?.ext_cost_raw || 0), 0) || null;

  const conflicts = [];
  if (printedQtyRaw !== null && calculatedQty !== null && printedQtyRaw !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', message: 'Printed total quantity does not match extracted row quantity sum.', printed: printedQtyRaw, extracted: calculatedQty });
  }
  if (printedAmountRaw !== null && calculatedAmount !== null && Math.abs(printedAmountRaw - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'totals.amount', message: 'Printed total amount does not match extracted row extension sum.', printed: printedAmountRaw, extracted: calculatedAmount });
  }

  return {
    parser: 'ollies',
    document_family: 'ollies_purchase_order',
    layout_version: 'ollies_legacy_table_v1',
    document_identity: {
      legal_entity_raw: legalEntityRaw,
      brand_raw: brandRaw,
      customer_candidate: 'OLLIES',
      customer_candidate_source: 'document_family',
      a2000_customer_code: null
    },
    confidence: orderNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.45,
    header: {
      customer_raw: legalEntityRaw,
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDateRaw),
      start_date: normalizeDate(startDateRaw),
      cancel_date: normalizeDate(cancelDateRaw),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: shipToNumberRaw,
      store_code: null,
      terms_raw: termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        legal_entity_raw: legalEntityRaw,
        brand_raw: brandRaw,
        order_date_raw: orderDateRaw,
        start_ship_date_raw: startDateRaw,
        end_ship_date_raw: cancelDateRaw,
        expected_receipt_date_raw: expectedReceiptDateRaw,
        ship_to_raw: shipToRaw,
        ship_to_number_raw: shipToNumberRaw,
        terms_raw: termsRaw,
        freight_raw: freightRaw,
        fob_raw: fobRaw,
        buyer_code_raw: buyerCodeRaw,
        buyer_name_raw: buyerNameRaw,
        vendor_number_raw: vendorNumberRaw
      }
    },
    lines,
    totals: {
      qty: calculatedQty,
      amount: calculatedAmount,
      printed_qty_raw: printedQtyRaw,
      printed_amount_raw: printedAmountRaw
    },
    conflicts
  };
}
