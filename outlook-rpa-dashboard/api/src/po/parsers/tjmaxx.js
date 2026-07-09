import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function linesOf(text) { return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, '')); }

function extractHeaderDates(rawLines) {
  const labelIndex = rawLines.findIndex((line) => /ORDER DATE/i.test(line) && /CANCELLED IF NOT RECEIVED BY DATE/i.test(line));
  if (labelIndex < 0) return { orderDateRaw: null, startDateRaw: null, cancelDateRaw: null };
  const dates = [];
  for (const line of rawLines.slice(labelIndex + 1, labelIndex + 12)) {
    for (const match of String(line).matchAll(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/g)) dates.push(match[0]);
    if (dates.length >= 3) break;
  }
  return { orderDateRaw: dates[0] || null, startDateRaw: dates[1] || null, cancelDateRaw: dates[2] || null };
}

export function parseTjMaxx({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);
  const orderNo = clean(oneLine.match(/DOMESTIC PO NO:\s*([A-Z0-9-]+)/i)?.[1] || oneLine.match(/DOMESTIC PO #\s+([A-Z0-9-]+)/i)?.[1]) || null;
  const deptRaw = clean(oneLine.match(/\bDEPT:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const referenceRaw = clean(oneLine.match(/REFERENCE NO:\s*([A-Z0-9-]+)/i)?.[1] || oneLine.match(/REFERENCE #\s+([A-Z0-9-]+)/i)?.[1]) || null;
  const vendorNoRaw = clean(oneLine.match(/VENDOR NO:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const vendorNameRaw = clean(oneLine.match(/VENDOR NAME:\s*(.+?)\s+FOB POINT/i)?.[1] || oneLine.match(/VENDOR NAME:\s*(.+?)\s+PACK QTY/i)?.[1]) || null;
  const { orderDateRaw, startDateRaw, cancelDateRaw } = extractHeaderDates(rawLines);
  const paymentMatch = oneLine.match(/PAYMENT TERMS\s+DISC:\s*.*?DAYS:\s*(\d{1,3})\s+FROM:\s*([A-Z0-9]+)/i);
  const termsRaw = paymentMatch ? `DAYS ${paymentMatch[1]} FROM ${paymentMatch[2]}` : null;
  const printedTotalQty = normalizeInteger(oneLine.match(/TOTAL PO UNITS\s+([\d,]+)/i)?.[1]);

  const lines = [];
  for (const rawLine of rawLines) {
    if (!/^\s*\d+\/\d+\s{2,}/.test(rawLine)) continue;
    const cols = String(rawLine).trim().split(/\s{2,}/).map(clean).filter(Boolean);
    if (cols.length < 8 || !/^\d+(?:\.\d+)?$/.test(cols[3] || '') || !/^[A-Z0-9][A-Z0-9./-]+$/i.test(cols[4] || '')) continue;
    const pageLineRaw = cols[0];
    const categoryRaw = cols[1];
    const merchTypeRaw = cols[2];
    const unitCostRaw = normalizeMoney(cols[3]);
    const vendorStyleRaw = cols[4];
    const descriptionRaw = cols[5];
    const unitsRaw = normalizeInteger(cols[6]);
    if (!vendorStyleRaw || unitsRaw === null) continue;
    lines.push({
      line_no: lines.length + 1,
      customer_sku: null,
      ticket_sku: null,
      upc: null,
      style_raw: vendorStyleRaw,
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: descriptionRaw || null,
      sales_price: unitCostRaw,
      list_price: null,
      qty_total: unitsRaw,
      warehouse_code: null,
      raw: {
        source: 'tjmaxx_domestic_purchase_order_v1',
        page_line_raw: pageLineRaw,
        category_raw: categoryRaw,
        merch_type_raw: merchTypeRaw,
        vendor_style_raw: vendorStyleRaw,
        composite_style_color_semantics: 'STYLE_COLOR_SUFFIX',
        description_raw: descriptionRaw || null,
        unit_cost_raw: unitCostRaw,
        quantity_raw: unitsRaw,
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'UNITS',
        size_ratio_raw: null,
        size_ratio_absent_in_source: true,
        matched_text: clean(rawLine)
      }
    });
  }

  const calculatedQty = lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null;
  const conflicts = [{
    field: 'order_no', code: 'order_no_requires_business_review', severity: 'high', blocking: true,
    message: 'The printed TJ Maxx DOMESTIC PO NO is preserved as RAW document evidence, but business confirmed it must not be assumed to be the final American Exchange/A2000 order number without review.',
    printed_order_no_raw: orderNo
  }];
  if (printedTotalQty !== null && calculatedQty !== null && printedTotalQty !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'TJ Maxx TOTAL PO UNITS does not match extracted line quantity sum.', printed: printedTotalQty, extracted: calculatedQty });
  }
  const warnings = [{
    field: 'store_code', code: 'routing_instructions_required_for_destination', severity: 'medium', blocking: false,
    message: 'The TJ Maxx purchase order explicitly requires separate Routing and Distribution Instructions. The PO itself does not provide one authoritative Ship To/DC, so STORE_NO is not inferred from FOB Point or generic instruction pages.'
  }];

  return {
    parser: 'tjmaxx', document_family: 'tjmaxx_domestic_purchase_order', layout_version: 'tjmaxx_domestic_po_v1',
    document_identity: { legal_entity_raw: clean(oneLine.match(/(TJX Companies Inc\.)/i)?.[1]) || null, brand_raw: null, customer_candidate: 'TJMAXX', customer_candidate_source: 'document_family_signature', a2000_customer_code: null },
    confidence: orderNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.4,
    header: {
      customer_raw: null, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDateRaw), start_date: normalizeDate(startDateRaw), cancel_date: normalizeDate(cancelDateRaw), book_date: null,
      dept_raw: deptRaw, dept_code: null, division_code: null,
      store_raw: null, store_code: null,
      terms_raw: termsRaw, terms_code: null, ship_via_code: null, warehouse_code: null,
      raw: { dept_raw: deptRaw, reference_raw: referenceRaw, vendor_no_raw: vendorNoRaw, vendor_name_raw: vendorNameRaw, order_date_raw: orderDateRaw, start_ship_date_raw: startDateRaw, cancel_date_raw: cancelDateRaw, payment_terms_raw: termsRaw, routing_document_required_raw: true }
    },
    lines,
    totals: { qty: calculatedQty, printed_qty_raw: printedTotalQty },
    conflicts,
    warnings
  };
}
