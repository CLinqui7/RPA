import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function collapseRepeatedLetters(value) {
  // Some Shoe Show PDFs extract headings as PPPPUUUURRRRCCCCHHHHAAAASSSSEEEE.
  return String(value || '').replace(/([A-Za-z])\1{2,}/g, '$1');
}

function clean(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function cleanTerms(value) {
  const raw = clean(value);
  if (!raw) return null;
  return raw.replace(/^TERMS:\s*/i, '').replace(/\s*\|.*$/, '').trim() || null;
}

function firstPageText(text) {
  return String(text || '').split('\f')[0] || String(text || '');
}

function findDateTriplet(lines = []) {
  for (const line of lines) {
    const dates = line.match(/\d{1,2}\/\d{1,2}\/\d{2,4}/g);
    if (dates && dates.length >= 3) {
      return { orderDate: dates[0], shipDate: dates[1], cancelDate: dates[2] };
    }
  }
  return { orderDate: null, shipDate: null, cancelDate: null };
}

function findShoeShowItemLines(pageLines = []) {
  const items = [];
  let inTable = false;

  for (const rawLine of pageLines) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) continue;
    if (/\*\*\s*S\s*T\s*O\s*C\s*K\s*#\s*\*\*/i.test(line) || /DESCRIPTION\s+COLOR\s+QUANTITY/i.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^QTY\s+CASES\s+WD\b/i.test(line)) break;
    if (!inTable) continue;

    // Example: 072096  WHITE MOUNTAIN HAMPTON SDE  TPE  2808
    const match = line.match(/^(\d{4,12})\s+(?:\(([^)]+)\)\s+)?(.+?)\s+([A-Z0-9]{2,8})\s+([\d,]+)\s*$/i);
    if (!match) continue;
    items.push({
      stock: clean(match[1]),
      ticketFlag: clean(match[2]),
      description: clean(match[3]),
      colorRaw: clean(match[4]),
      qty: normalizeInteger(match[5])
    });
  }
  return items;
}


function parseShipTo(pageLines = []) {
  const joined = pageLines.join(' ');
  const match = joined.match(/Ship\s+To:\s*SHOE\s+SHOW,?\s+INC\.?\s+(\d+\s+TRINITY\s+CHURCH\s+ROAD)\s+(CONCORD),?\s*N\.?C\.?\s+(\d{5})/i);
  if (!match) return null;
  return {
    semantics: 'SHIP_TO',
    name_raw: 'SHOE SHOW, INC.',
    address1_raw: clean(match[1]),
    city_raw: clean(match[2]),
    state_raw: 'NC',
    postal_raw: clean(match[3]),
    block_raw: clean(match[0])
  };
}

function parsePatternEvidence(pageLines = []) {
  const index = pageLines.findIndex((line) => /\bPATTERN:/i.test(line));
  if (index < 0) return { patternRaw: null, styleCandidateRaw: null, colorDescriptionCandidateRaw: null };

  const fragments = [];
  const first = pageLines[index].replace(/^.*?PATTERN:\s*/i, '');
  if (clean(first)) fragments.push(clean(first));
  for (let i = index + 1; i < Math.min(pageLines.length, index + 5); i += 1) {
    const line = pageLines[i];
    if (/SOCK\s+STAMP|\*\*\s*S\s*T\s*O\s*C\s*K|_{8,}/i.test(line)) break;
    if (clean(line)) fragments.push(clean(line));
  }

  const patternRaw = clean(fragments.join(' '));
  const styleCandidateRaw = clean(patternRaw?.match(/STYLE#?\s*([A-Z0-9-]+)/i)?.[1]) || null;

  // Keep the full printed descriptive text and only derive a candidate phrase at a visible delimiter.
  // Example: "TAUPE SUEDE W/ BRUSHED..." -> candidate "TAUPE SUEDE".
  const descriptiveLine = fragments.find((value) => !/STYLE#?/i.test(value)) || null;
  const colorDescriptionCandidateRaw = clean(descriptiveLine?.split(/\s+W\/\s+|\s+WITH\s+/i)?.[0]) || null;
  return { patternRaw, styleCandidateRaw, colorDescriptionCandidateRaw };
}

function numericTokensWithPositions(line = '') {
  return [...String(line).matchAll(/\d+(?:\/\d+)?/g)].map((match) => ({
    raw: match[0],
    start: match.index,
    end: match.index + match[0].length,
    center: match.index + ((match[0].length - 1) / 2)
  }));
}

function extractSizeGridEvidence(pageLines = []) {
  const firstHeaderIndex = pageLines.findIndex((line) => /^\s*QTY\s+CASES\s+WD\b/i.test(line));
  if (firstHeaderIndex < 0) return null;

  const headerLines = [];
  for (let i = firstHeaderIndex; i < Math.min(pageLines.length, firstHeaderIndex + 4); i += 1) {
    const line = pageLines[i];
    if (/^\s*[\d,]+\s+[\d,]+\/\d+/i.test(line)) break;
    if (/\d/.test(line) || /QTY\s+CASES\s+WD/i.test(line)) headerLines.push({ index: i, raw: line });
  }

  const sizeColumns = [];
  for (const { raw } of headerLines) {
    for (const token of numericTokensWithPositions(raw)) {
      const size = Number(token.raw);
      if (!Number.isInteger(size) || size < 1 || size > 99) continue;
      sizeColumns.push({ size_raw: token.raw, start: token.start, center: token.center });
    }
  }
  sizeColumns.sort((a, b) => a.center - b.center);

  const totalsIndex = pageLines.findIndex((line, index) => index > firstHeaderIndex && /\bTOTALS\b/i.test(line) && /\d/.test(line));
  if (totalsIndex < 0) {
    return {
      size_header_lines_raw: headerLines.map((entry) => entry.raw),
      size_columns_raw: sizeColumns,
      totals_row_raw: null,
      printed_total_raw: null,
      size_grid_entries_raw: []
    };
  }

  const totalsLine = pageLines[totalsIndex];
  const totalsTokens = numericTokensWithPositions(totalsLine);
  const printedTotalRaw = normalizeInteger(totalsTokens[0]?.raw);
  const qtyTokens = totalsTokens.slice(1);
  const entries = qtyTokens.map((qtyToken) => {
    const nearest = sizeColumns
      .map((column) => ({ ...column, distance: Math.abs(column.center - qtyToken.center) }))
      .sort((a, b) => a.distance - b.distance)[0] || null;
    return {
      size_raw: nearest && nearest.distance <= 3.5 ? nearest.size_raw : null,
      qty_raw: normalizeInteger(qtyToken.raw),
      value_start: qtyToken.start,
      matched_header_start: nearest?.start ?? null,
      column_distance: nearest?.distance ?? null
    };
  });

  const gridRowsRaw = pageLines
    .slice(firstHeaderIndex + 1, totalsIndex)
    .filter((line) => /^\s*[\d,]+\s+[\d,]+\/\d+/i.test(line))
    .map((line) => clean(line));

  return {
    size_header_lines_raw: headerLines.map((entry) => entry.raw),
    size_columns_raw: sizeColumns,
    grid_rows_raw: gridRowsRaw,
    totals_row_raw: totalsLine,
    printed_total_raw: printedTotalRaw,
    size_grid_entries_raw: entries
  };
}

export function parseShoeShow({ text }) {
  const normalizedText = collapseRepeatedLetters(text || '');
  const pageOne = firstPageText(normalizedText);
  const pageLines = pageOne.split('\n');
  const oneLine = compactText(pageOne);
  const allOneLine = compactText(normalizedText);

  const orderNo = oneLine.match(/PURCHASE\s+ORDER\s*#\s*(\d{4,12})/i)?.[1]
    || allOneLine.match(/PURCHASE\s+ORDER\s*#\s*(\d{4,12})/i)?.[1]
    || null;
  const { orderDate, shipDate, cancelDate } = findDateTriplet(pageLines);
  const termsRaw = cleanTerms(oneLine.match(/TERMS:\s*([^|]+?NET\s+\d+\s+DAYS)/i)?.[0])
    || cleanTerms(oneLine.match(/TERMS:\s*([^|]+)/i)?.[0])
    || null;
  const price = normalizeMoney(oneLine.match(/COST:\s*\$?\s*([\d,.]+)/i)?.[1]);
  const brandRaw = clean(pageLines.find((line) => /\bSHOE\s+SHOW,?\s+INC\.?\b/i.test(line))?.match(/SHOE\s+SHOW,?\s+INC\.?/i)?.[0]) || null;
  const patternEvidence = parsePatternEvidence(pageLines);
  const shipTo = parseShipTo(pageLines);
  const itemRows = findShoeShowItemLines(pageLines);
  const sizeGrid = extractSizeGridEvidence(pageLines);

  const lines = itemRows.map((item, index) => ({
    line_no: index + 1,
    customer_sku: item.stock,
    ticket_sku: item.stock,
    upc: null,
    style_raw: patternEvidence.styleCandidateRaw,
    style_code: null,
    color_raw: item.colorRaw,
    color_code: null,
    size_raw: null,
    size_code: null,
    description: item.description,
    list_price: null,
    sales_price: price,
    qty_total: item.qty,
    warehouse_code: null,
    raw: {
      source: 'shoeshow_vendor_copy_v2_master_only',
      stock_number_raw: item.stock,
      ticket_flag_raw: item.ticketFlag,
      item_description_raw: item.description,
      printed_color_token_raw: item.colorRaw,
      color_description_candidate_raw: patternEvidence.colorDescriptionCandidateRaw,
      pattern_raw: patternEvidence.patternRaw,
      style_candidate_raw: patternEvidence.styleCandidateRaw,
      style_resolution_hint: patternEvidence.styleCandidateRaw ? 'EXACT_MASTER_STYLE_NORMALIZED' : null,
      quantity_raw: item.qty,
      quantity_semantics: 'EACH',
      quantity_uom_raw: 'QUANTITY',
      size_grid: sizeGrid
    }
  }));

  const totalQty = lines.reduce((sum, line) => sum + (normalizeInteger(line.qty_total) || 0), 0)
    || sizeGrid?.printed_total_raw
    || null;
  const amount = price !== null && totalQty !== null ? Number((price * totalQty).toFixed(2)) : null;
  const conflicts = [];
  const warnings = [];

  if (sizeGrid?.printed_total_raw !== null && totalQty !== null && sizeGrid.printed_total_raw !== totalQty) {
    conflicts.push({
      field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true,
      message: 'Printed Shoe Show TOTALS quantity does not match extracted line quantity.',
      printed: sizeGrid.printed_total_raw, calculated: totalQty
    });
  }
  if (sizeGrid?.size_grid_entries_raw?.length) {
    warnings.push({
      field: 'qty_szn', code: 'size_grid_requires_official_scale_mapping', severity: 'low', blocking: false,
      message: 'The PDF size grid was preserved by visual column position. QTY_SZn may only be populated after exact style/color and official VR_UPC_STYLE size-name mapping are resolved.'
    });
  }

  return {
    parser: 'shoeshow',
    document_family: 'shoeshow_vendor_copy_purchase_order',
    layout_version: 'shoeshow_vendor_copy_v2_master_only',
    document_identity: {
      legal_entity_raw: brandRaw,
      brand_raw: brandRaw,
      customer_candidate: 'SHOE4500',
      customer_candidate_source: 'document_family_signature',
      a2000_customer_code: null
    },
    confidence: orderNo && lines.length ? 0.94 : lines.length ? 0.72 : 0.4,
    header: {
      customer_raw: brandRaw,
      customer_code: null,
      order_no: orderNo,
      order_date: normalizeDate(orderDate),
      start_date: normalizeDate(shipDate),
      cancel_date: normalizeDate(cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: 'SAME',
      store_code: null,
      terms_raw: termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        cost_raw: price,
        pattern_raw: patternEvidence.patternRaw,
        style_candidate_raw: patternEvidence.styleCandidateRaw,
        color_description_candidate_raw: patternEvidence.colorDescriptionCandidateRaw,
        ship_to: shipTo,
        default_store_code_raw: shipTo ? null : 'SAME',
        default_store_reason: shipTo ? null : 'Shoe Show source text did not expose an authoritative Ship To block; business rule uses SHOE4500 SAME store pending sales review.'
      }
    },
    lines,
    totals: { qty: totalQty, amount },
    conflicts,
    warnings
  };
}
