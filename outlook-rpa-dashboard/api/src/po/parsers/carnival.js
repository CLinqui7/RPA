import { compactText, normalizeInteger, normalizeMoney } from '../helpers.js';

const MONTHS = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12'
};

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function linesOf(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, ''));
}

function normalizeCarnivalDate(value) {
  const raw = clean(value).toUpperCase();
  const match = raw.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/);
  if (!match || !MONTHS[match[2]]) return raw || null;
  return `${match[3]}-${MONTHS[match[2]]}-${match[1].padStart(2, '0')}`;
}

function extractDescriptionSignals(description) {
  const raw = clean(description);
  const colorRaw = clean(raw.match(/\bWATER\s+SHOES\s*-\s*([A-Z][A-Z ]*?)\s+ACTIVE\b/i)?.[1]) || null;
  const sizeRaw = clean(raw.match(/\b(M\d+\s*\/\s*W\d+)\b/i)?.[1])?.replace(/\s+/g, '') || null;
  const packQtyCandidateRaw = normalizeInteger(raw.match(/\((\d+)\)\s*$/)?.[1]);
  return { colorRaw, sizeRaw, packQtyCandidateRaw };
}

export function parseCarnival({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);

  const orderNo = clean(oneLine.match(/\bPURCHASE ORDER NO\s+(\d{5,12})\b/i)?.[1]) || null;
  const legalEntityLine = rawLines.find((line) => line.includes('PURCHASE ORDER') && /Carnival Cruise Line/i.test(line));
  const legalEntityRaw = clean(legalEntityLine?.match(/PURCHASE ORDER\s+(.+?)\s*$/i)?.[1]) || null;
  const brandRaw = clean(oneLine.match(/\b(Carnival Cruise Line)\b/i)?.[1]) || null;
  const vendorNumberRaw = clean(oneLine.match(/\bVendor\s+([A-Z0-9-]+)\b/i)?.[1]) || null;
  const requestorRaw = clean(oneLine.match(/\bRequestor:\s*([^\n]+?)\s+DATE ORDERED\b/i)?.[1])
    || clean(oneLine.match(/\bRequestor:\s*([A-Z][A-Z .'-]+)\b/i)?.[1])
    || null;

  const headerValueLine = rawLines.find((line) => /\b\d{1,2}-[A-Z]{3}-\d{4}\b/.test(line) && /\bNET\s+\d+\b/i.test(line));
  const headerValues = headerValueLine?.match(/^\s*(\d{1,2}-[A-Z]{3}-\d{4})\s+(NET\s+\d+)\s+([A-Z0-9-]+)\s+([A-Z]+)\s+([A-Za-z]+)\s+([A-Za-z]+)\s+([A-Z]{3})\s*$/i);
  const orderDateRaw = clean(headerValues?.[1]) || null;
  const termsRaw = clean(headerValues?.[2]) || null;
  const floridaTaxNumberRaw = clean(headerValues?.[3]) || null;
  const shipViaRaw = clean(headerValues?.[4]) || null;
  const fobRaw = clean(headerValues?.[5]) || null;
  const freightTermsRaw = clean(headerValues?.[6]) || null;
  const currencyRaw = clean(headerValues?.[7]) || null;

  const rowPattern = /^\s*(\d+)\s+([\d,]+)\s+([A-Z]+)\s+([A-Z0-9-]+)\s+(.+?)\s+(\d{1,2}-[A-Z]{3}-\d{4})\s+([\d,.]+)\s+([\d,]+(?:\.\d{2})?)\s*$/i;
  const lines = [];

  for (const rawLine of rawLines) {
    const match = rawLine.match(rowPattern);
    if (!match) continue;

    const lineNo = normalizeInteger(match[1]);
    const quantityRaw = normalizeInteger(match[2]);
    const uomRaw = clean(match[3]).toUpperCase();
    const itemNumberRaw = clean(match[4]);
    const descriptionRaw = clean(match[5]);
    const dateRequiredRaw = clean(match[6]);
    const unitPriceRaw = normalizeMoney(match[7]);
    const totalPriceRaw = normalizeMoney(match[8]);
    const signals = extractDescriptionSignals(descriptionRaw);
    const derivedEachQtyCandidate = quantityRaw !== null && signals.packQtyCandidateRaw !== null
      ? quantityRaw * signals.packQtyCandidateRaw
      : null;

    lines.push({
      line_no: lineNo,
      customer_sku: itemNumberRaw,
      ticket_sku: null,
      upc: null,
      style_raw: null,
      style_code: null,
      color_raw: signals.colorRaw,
      color_code: null,
      size_raw: signals.sizeRaw,
      size_code: null,
      description: descriptionRaw,
      sales_price: unitPriceRaw,
      list_price: null,
      qty_total: quantityRaw,
      warehouse_code: null,
      raw: {
        source: 'carnival_purchase_order_v1',
        po_line_raw: lineNo,
        quantity_raw: quantityRaw,
        uom_raw: uomRaw,
        quantity_semantics: uomRaw === 'CASE' ? 'CASE' : 'UNKNOWN',
        item_number_raw: itemNumberRaw,
        description_raw: descriptionRaw,
        color_candidate_raw: signals.colorRaw,
        size_candidate_raw: signals.sizeRaw,
        pack_qty_candidate_raw: signals.packQtyCandidateRaw,
        derived_each_qty_candidate: derivedEachQtyCandidate,
        date_required_raw: dateRequiredRaw,
        unit_price_raw: unitPriceRaw,
        total_price_raw: totalPriceRaw,
        matched_text: rawLine.trim()
      }
    });
  }

  const printedTotalAmountRaw = normalizeMoney(oneLine.match(/\bTOTAL\s+([\d,]+(?:\.\d{2}))\s+USD\b/i)?.[1]);
  const rawOrderedQuantity = lines.reduce((sum, line) => sum + (line.raw?.quantity_raw || 0), 0) || null;
  const derivedEachQtyCandidate = lines.reduce((sum, line) => sum + (line.raw?.derived_each_qty_candidate || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (line.raw?.total_price_raw || 0), 0) || null;
  const rawUoms = [...new Set(lines.map((line) => line.raw?.uom_raw).filter(Boolean))];
  const conflicts = [];

  if (printedTotalAmountRaw !== null && calculatedAmount !== null && Math.abs(printedTotalAmountRaw - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'totals.amount', message: 'Printed PO total does not match extracted row total sum.', printed: printedTotalAmountRaw, extracted: calculatedAmount });
  }

  return {
    parser: 'carnival',
    document_family: 'carnival_purchase_order',
    layout_version: 'carnival_purchase_order_v1',
    document_identity: {
      legal_entity_raw: legalEntityRaw,
      brand_raw: brandRaw,
      customer_candidate: 'CARNIVAL',
      customer_candidate_source: 'document_family',
      a2000_customer_code: null
    },
    confidence: orderNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.45,
    header: {
      customer_raw: legalEntityRaw,
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeCarnivalDate(orderDateRaw),
      start_date: null,
      cancel_date: null,
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        legal_entity_raw: legalEntityRaw,
        brand_raw: brandRaw,
        order_date_raw: orderDateRaw,
        terms_raw: termsRaw,
        florida_tax_number_raw: floridaTaxNumberRaw,
        ship_via_raw: shipViaRaw,
        fob_raw: fobRaw,
        freight_terms_raw: freightTermsRaw,
        currency_raw: currencyRaw,
        vendor_number_raw: vendorNumberRaw,
        requestor_raw: requestorRaw
      }
    },
    lines,
    totals: {
      qty: null,
      amount: calculatedAmount,
      raw_ordered_quantity: rawOrderedQuantity,
      raw_uom: rawUoms.length === 1 ? rawUoms[0] : null,
      derived_each_qty_candidate: derivedEachQtyCandidate,
      printed_amount_raw: printedTotalAmountRaw
    },
    conflicts
  };
}
