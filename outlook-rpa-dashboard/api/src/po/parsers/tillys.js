import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function linesOf(text) { return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, '')); }

export function parseTillys({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);
  const topLine = rawLines.find((line) => /AMERICAN EXCHANGE GROUP/i.test(line) && (line.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length >= 2) || '';
  const topMatch = topLine.match(/^\s*([A-Z0-9-]+)\s{2,}AMERICAN EXCHANGE GROUP\s{2,}([A-Z0-9-]+)\s{2,}(\d{1,2}\/\d{1,2}\/\d{2,4})\s{2,}(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const orderNo = clean(topMatch?.[1]) || null;
  const vendorNumberRaw = clean(topMatch?.[2]) || null;
  const startDateRaw = clean(topMatch?.[3]) || null;
  const cancelDateRaw = clean(topMatch?.[4]) || null;

  const contactDateLine = rawLines.find((line) => /\bJORDAN\b/i.test(line) && (line.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || []).length >= 2) || '';
  const contactRaw = clean(contactDateLine.match(/\b(JORDAN)\b/i)?.[1]) || null;
  const dateMatches = contactDateLine.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g) || [];
  const orderDateRaw = dateMatches[0] || null;
  const dateEnteredRaw = dateMatches[1] || null;
  const termsRaw = clean(oneLine.match(/\b(\d+(?:\.\d+)?%\s+\d+\s+NET\s+\d+)\b/i)?.[1]) || null;

  const customerStyleLine = rawLines.find((line) => /^\s*No\s+\d+\s{2,}.+/i.test(line)) || '';
  const customerStyleMatch = customerStyleLine.match(/^\s*No\s+(\d+)\s{2,}(.+?)\s*$/i);
  const customerStyleRaw = clean(customerStyleMatch?.[1]) || null;
  const descriptionRaw = clean(customerStyleMatch?.[2]) || null;

  // Require a hyphenated vendor-style token so the PO header number cannot be mistaken for a detail row.
  const vendorStyleLine = rawLines.find((line) => /^\s*\d{2,4}\s+[A-Z0-9]+(?:-[A-Z0-9]+){2,}\s{2,}[A-Z0-9./-]+\s*$/i.test(line)) || '';
  const vendorStyleMatch = vendorStyleLine.match(/^\s*(\d{2,4})\s+([A-Z0-9]+(?:-[A-Z0-9]+){2,})\s{2,}([A-Z0-9./-]+)\s*$/i);
  const subClassRaw = clean(vendorStyleMatch?.[1]) || null;
  const vendorStyleRaw = clean(vendorStyleMatch?.[2]) || null;
  const sizeRaw = clean(vendorStyleMatch?.[3]) || null;

  const colorNameLineIndex = rawLines.findIndex((line) => /^\s*[A-Z][A-Z /-]+\s*$/.test(line) && /BURGUNDY/i.test(line));
  const colorNameRaw = colorNameLineIndex >= 0 ? clean(rawLines[colorNameLineIndex]) : null;
  const colorCodeLine = colorNameLineIndex >= 0 ? rawLines.slice(colorNameLineIndex + 1, colorNameLineIndex + 5).find((line) => /^\s*\d+\s+[A-Z]/.test(line)) || '' : '';
  const colorCodeMatch = colorCodeLine.match(/^\s*(\d+)\s+(.+?)\s{2,}([\d,.]+)\s+([\d,]+)\s*$/i);
  const customerColorCodeRaw = clean(colorCodeMatch?.[1]) || null;
  const colorRaw = colorNameRaw || clean(colorCodeMatch?.[2]) || null;
  const costRaw = normalizeMoney(colorCodeMatch?.[3]);
  const totalUnitsRaw = normalizeInteger(colorCodeMatch?.[4]);

  const summaryLine = rawLines.find((line) => /FINELINE Hang Tag/i.test(line)) || '';
  const summaryNumbers = summaryLine.trim().split(/\s{2,}/).map(clean).filter(Boolean);
  const packQtyRaw = normalizeInteger(summaryNumbers[0]);
  const averageUnitCostRaw = normalizeMoney(summaryNumbers[2]);
  const totalUnitCostRaw = normalizeMoney(summaryNumbers[3]);

  const line = vendorStyleRaw ? {
    line_no: 1,
    customer_sku: customerStyleRaw,
    ticket_sku: null,
    upc: null,
    style_raw: vendorStyleRaw,
    style_code: null,
    color_raw: colorRaw,
    color_code: null,
    size_raw: sizeRaw,
    size_code: null,
    description: descriptionRaw,
    sales_price: costRaw,
    list_price: null,
    qty_total: totalUnitsRaw,
    warehouse_code: null,
    raw: {
      source: 'tillys_as400_po_v2_master_only',
      tillys_style_raw: customerStyleRaw,
      vendor_style_raw: vendorStyleRaw,
      style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED',
      vendor_color_name_raw: colorNameRaw,
      customer_color_code_raw: customerColorCodeRaw,
      size_raw: sizeRaw,
      sub_class_raw: subClassRaw,
      quantity_raw: totalUnitsRaw,
      quantity_semantics: 'EACH',
      quantity_uom_raw: 'TOTAL UNITS',
      cost_raw: costRaw,
      pack_qty_raw: packQtyRaw,
      average_unit_cost_raw: averageUnitCostRaw,
      total_unit_cost_raw: totalUnitCostRaw,
      vendor_style_line_raw: vendorStyleLine || null,
      color_detail_line_raw: colorCodeLine || null
    }
  } : null;

  const conflicts = [];
  if (line && totalUnitCostRaw !== null && line.qty_total !== null && line.sales_price !== null) {
    const calculated = Number(line.qty_total) * Number(line.sales_price);
    if (Number.isFinite(calculated) && Math.abs(totalUnitCostRaw - calculated) > 0.01) {
      conflicts.push({ field: 'totals.amount', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed total unit cost does not match quantity x unit cost.', printed: totalUnitCostRaw, extracted: calculated });
    }
  }

  return {
    parser: 'tillys', document_family: 'tillys_as400_purchase_order', layout_version: 'tillys_as400_po_v2_master_only',
    document_identity: { legal_entity_raw: null, brand_raw: null, customer_candidate: 'TILLYS', customer_candidate_source: 'document_family_signature', a2000_customer_code: null },
    confidence: orderNo && line ? 0.96 : line ? 0.78 : 0.35,
    header: {
      customer_raw: null, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDateRaw), start_date: normalizeDate(startDateRaw), cancel_date: normalizeDate(cancelDateRaw), book_date: null,
      dept_raw: subClassRaw, dept_code: null, division_code: null, store_raw: 'SAME', store_code: null,
      terms_raw: termsRaw, terms_code: null, ship_via_code: null, warehouse_code: null,
      raw: {
        vendor_name_raw: clean(topLine.match(/AMERICAN EXCHANGE GROUP/i)?.[0]) || null,
        vendor_number_raw: vendorNumberRaw, contact_raw: contactRaw, order_date_raw: orderDateRaw,
        date_entered_raw: dateEnteredRaw, start_ship_date_raw: startDateRaw, cancel_date_raw: cancelDateRaw,
        terms_raw: termsRaw, ship_to: null, default_store_code_raw: 'SAME', default_store_reason: 'No authoritative Ship To printed. Business rule uses TILLYS SAME store for this layout.',
        identity_note: 'Tillys logo/headquarters artwork is not treated as Ship To. STORE_NO uses explicit SAME business rule for this layout.'
      }
    },
    lines: line ? [line] : [],
    totals: { qty: line?.qty_total ?? null, amount: totalUnitCostRaw ?? null, printed_qty_raw: totalUnitsRaw, printed_amount_raw: totalUnitCostRaw },
    conflicts
  };
}
