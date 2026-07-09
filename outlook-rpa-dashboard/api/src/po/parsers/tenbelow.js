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


function parseShipToCandidates(rawLines = []) {
  const candidates = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    if (!/SHIP\s+TO/i.test(line)) continue;
    const window = rawLines.slice(index, index + 8).map(clean).filter(Boolean);
    const joined = window.join(' ');
    const address = joined.match(/(?:^|\b)(\d{3,6}\s+Crestwood\s+Blvd\.?)[,\s]+(Birmingham|Irondale),?\s+AL\s+(\d{5})/i);
    const name = joined.match(/SHIP\s+TO:?\s*(Simply\s+10|SIMPLY\s+10\s+c\/o\s+JayDee|Tiger\s+Freight\s+Services,?\s+Inc\.?)/i)?.[1]
      || window.find((value) => /Simply\s+10|Tiger\s+Freight/i.test(value)) || null;
    candidates.push({
      semantics: 'SHIP_TO',
      name_raw: clean(name) || null,
      address1_raw: clean(address?.[1]) || null,
      city_raw: clean(address?.[2]) || null,
      state_raw: address ? 'AL' : null,
      postal_raw: clean(address?.[3]) || null,
      block_raw: window
    });
  }
  return candidates.filter((candidate) => candidate.name_raw || candidate.address1_raw);
}

function styleSuffixCandidate(vendorStyleRaw) {
  const match = clean(vendorStyleRaw).match(/^(.+)-([A-Z0-9]{2,8})$/i);
  if (!match) return { base: null, suffix: null };
  return { base: clean(match[1]), suffix: clean(match[2]).toUpperCase() };
}

export function parseTenBelow({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);

  const purchaseNo = clean(oneLine.match(/\bPURCHASE\s*#\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const buyerRaw = clean(oneLine.match(/\bBUYER\s+(.+?)\s+PURCHASE\s*#/i)?.[1]) || null;
  const legalEntityRaw = clean(oneLine.match(/\b(10 Below LLC\.)(?=\s|$)/i)?.[1]) || null;
  const brandLine = rawLines.find((line) => /^\s*(?:[A-Z]\s+)?Simply 10\s*$/i.test(line));
  const brandRaw = clean(brandLine?.match(/Simply 10/i)?.[0]) || null;
  const vendorLine = rawLines.find((line) => /\bNAME\b/i.test(line) && /American Exchange/i.test(line));
  const vendorRaw = clean(vendorLine?.match(/NAME\s+(.+?)(?:\s{2,}|$)/i)?.[1]) || null;
  const shipToCandidatesRaw = parseShipToCandidates(rawLines);
  const primaryShipTo = shipToCandidatesRaw.find((candidate) => candidate.address1_raw) || shipToCandidatesRaw[0] || null;

  const labelLineIndex = rawLines.findIndex((line) => line.includes('DATE') && line.includes('SHIP DATE') && line.includes('CANCEL DATE') && line.includes('TERMS:'));
  const valueLine = labelLineIndex >= 0 ? rawLines[labelLineIndex + 1] || '' : '';
  const datesFromValueLine = [...valueLine.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)].map((match) => match[0]);
  const orderDateRaw = datesFromValueLine[0] || null;
  const startDateRaw = datesFromValueLine[1] || null;
  const cancelDateRaw = datesFromValueLine[2] || null;
  const termsRaw = clean(oneLine.match(/\bTERMS:\s*([0-9]+%\s*\/\s*\d+\s*DAYS)\b/i)?.[1]) || null;
  const termsBasisNoteRaw = clean(oneLine.match(/Terms begin the day goods arrive in Birmingham warehouse, not\s+date written on vendors invoice/i)?.[0]) || null;

  const rowPattern = /^\s*(\d+)\s+(\S+)\s+(.+?)\s{2,}(YES|NO)\s{2,}(.+?)\s{2,}(\d+\s+to\s+\d+)\s+.*?\$([\d,.]+)\s+([\d,]+)\s+\$([\d,.]+)\s*$/i;
  const lines = [];

  for (const rawLine of rawLines) {
    const match = rawLine.match(rowPattern);
    if (!match) continue;

    const rowNoRaw = clean(match[1]);
    const vendorStyleRaw = clean(match[2]);
    const descriptionRaw = clean(match[3]);
    const reorderRaw = clean(match[4]);
    const deptRaw = clean(match[5]);
    const sizeScaleRaw = clean(match[6]);
    const costRaw = normalizeMoney(match[7]);
    const totalUnitsRaw = normalizeInteger(match[8]);
    const totalCostRaw = normalizeMoney(match[9]);
    const suffix = styleSuffixCandidate(vendorStyleRaw);

    lines.push({
      line_no: normalizeInteger(rowNoRaw),
      customer_sku: null,
      ticket_sku: null,
      upc: null,
      style_raw: vendorStyleRaw,
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: sizeScaleRaw || null,
      size_code: null,
      description: descriptionRaw || null,
      sales_price: costRaw,
      list_price: null,
      qty_total: totalUnitsRaw,
      warehouse_code: null,
      raw: {
        source: 'tenbelow_wide_po_v1',
        row_number_raw: rowNoRaw,
        vendor_style_raw: vendorStyleRaw,
        style_base_candidate_raw: suffix.base,
        style_suffix_candidate_raw: suffix.suffix,
        composite_style_color_semantics: 'STYLE_COLOR_SUFFIX',
        description_raw: descriptionRaw || null,
        reorder_raw: reorderRaw || null,
        dept_raw: deptRaw || null,
        size_scale_raw: sizeScaleRaw || null,
        size_ratio_raw: null,
        master_pack_raw: null,
        inner_pack_raw: null,
        cost_raw: costRaw,
        retail_raw: null,
        total_units_raw: totalUnitsRaw,
        quantity_semantics: 'TOTAL_EACH_UNDISTRIBUTED',
        quantity_uom_raw: 'UNITS',
        total_cost_raw: totalCostRaw,
        matched_text: rawLine.trim()
      }
    });
  }

  const printedTotalLine = [...rawLines].reverse().find((line) => /^\s*[\d,]+\s+\$[\d,]+(?:\.\d{2})?\s*$/.test(line));
  const printedTotalMatch = printedTotalLine?.match(/^\s*([\d,]+)\s+\$([\d,]+(?:\.\d{2})?)\s*$/);
  const printedQtyRaw = normalizeInteger(printedTotalMatch?.[1]);
  const printedAmountRaw = normalizeMoney(printedTotalMatch?.[2]);
  const calculatedQty = lines.reduce((sum, line) => sum + (line.qty_total || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (line.raw?.total_cost_raw || 0), 0) || null;
  const conflicts = [];

  if (printedQtyRaw !== null && calculatedQty !== null && printedQtyRaw !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', message: 'Printed total units do not match extracted row quantity sum.', printed: printedQtyRaw, extracted: calculatedQty });
  }
  if (printedAmountRaw !== null && calculatedAmount !== null && Math.abs(printedAmountRaw - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'totals.amount', message: 'Printed total cost does not match extracted row total cost sum.', printed: printedAmountRaw, extracted: calculatedAmount });
  }

  return {
    parser: 'tenbelow',
    document_family: 'tenbelow_purchase_order',
    layout_version: 'tenbelow_wide_po_v1',
    document_identity: {
      legal_entity_raw: legalEntityRaw,
      brand_raw: brandRaw,
      customer_candidate: '10BELOW',
      customer_candidate_source: 'document_family',
      a2000_customer_code: null
    },
    confidence: purchaseNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.45,
    header: {
      customer_raw: legalEntityRaw,
      customer_code: null,
      order_no: purchaseNo,
      order_date: normalizeDate(orderDateRaw),
      start_date: normalizeDate(startDateRaw),
      cancel_date: normalizeDate(cancelDateRaw),
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
        buyer_raw: buyerRaw,
        vendor_raw: vendorRaw,
        order_date_raw: orderDateRaw,
        ship_date_raw: startDateRaw,
        cancel_date_raw: cancelDateRaw,
        terms_raw: termsRaw,
        terms_basis_note_raw: termsBasisNoteRaw,
        ship_to: primaryShipTo,
        ship_to_candidates_raw: shipToCandidatesRaw
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
