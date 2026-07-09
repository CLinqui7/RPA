import { cleanText, compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function linesOf(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n+/)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function normalizeFileNameValue(fileName, key) {
  const re = new RegExp(`${key}#\\s*(\\d+)`, 'i');
  return String(fileName || '').match(re)?.[1] || null;
}

function money(value) {
  return normalizeMoney(String(value || '').replace(/[$,]/g, ''));
}

function int(value) {
  return normalizeInteger(String(value || '').replace(/[,]/g, ''));
}

function tokenClean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const VISUAL_COLOR_STARTS = new Set([
  'BLACK', 'DOVE', 'KHAKI', 'PINK', 'RED', 'BROWN', 'WHITE', 'BLUE', 'MULTI',
  'TAN', 'NAVY', 'GREY', 'GRAY', 'TAUPE', 'IVORY', 'SILVER', 'GOLD',
  'BEIGE', 'NATURAL', 'GREEN', 'PURPLE', 'ORANGE', 'YELLOW'
]);

function isVisualColorStart(value) {
  return VISUAL_COLOR_STARTS.has(String(value || '').trim().toUpperCase());
}

function isStandaloneStyleSuffix(value) {
  const v = String(value || '').trim();
  if (!/^-?[A-Z0-9]{2,8}$/i.test(v)) return false;
  if (/^\d{5,12}$/.test(v)) return false;
  if (/^\$/.test(v) || /^\d+(?:\.\d{2})$/.test(v)) return false;
  if (/^(TOTAL|PAGE|UNITS|COST)$/i.test(v)) return false;
  return true;
}

function appendStyleSuffix(styleRaw, suffixRaw) {
  const suffix = String(suffixRaw || '').trim().toUpperCase();
  if (!suffix) return styleRaw;
  if (suffix.startsWith('-')) return `${styleRaw}${suffix}`;
  if (String(styleRaw || '').endsWith('-')) return `${styleRaw}${suffix}`;
  return `${styleRaw}-${suffix}`;
}

function suffixLineAfterRow(rawLines, startIndex) {
  const candidate = tokenClean(rawLines[startIndex + 1] || '');
  return isStandaloneStyleSuffix(candidate) ? candidate : null;
}

function isSkuToken(value) {
  // Bealls puede traer SKU de 6 dígitos en algunos POs bulk
  // y SKU de 7-12 dígitos en otros layouts.
  return /^\d{5,12}$/.test(String(value || '').trim());
}

function isPriceToken(value) {
  return /^\$?\d{1,6}(?:\.\d{2})$/.test(String(value || '').trim());
}

function isQtyToken(value) {
  return /^\d{1,6}$/.test(String(value || '').replace(/,/g, '').trim());
}

function isSizeToken(value) {
  const v = String(value || '').trim();
  return v === '.' || /^\d{1,3}[A-Z]?$/.test(v) || /^[A-Z]{1,4}$/.test(v);
}

function isSuffixToken(value) {
  return /^[A-Z0-9]{2,8}$/i.test(String(value || '').trim());
}

function normalizeStyleRaw(raw) {
  return String(raw || '').replace(/\s+/g, '').replace(/--+/g, '-').toUpperCase();
}

function extractDeptAndOrder(text, fileName = '') {
  const one = compactText(text);
  const deptFromFilename = normalizeFileNameValue(fileName, 'Dept');
  const poFromFilename = normalizeFileNameValue(fileName, 'PO');

  const direct = one.match(/DEPT\.\s*NUMBER:\s*(\d{1,6})\s+ORDER\s*NUMBER:\s*(\d{5,12})/i);
  if (direct) {
    return {
      deptFromFilename,
      deptFromPdf: direct[1],
      orderFromPdf: direct[2],
      deptNo: direct[1],
      orderNo: direct[2]
    };
  }

  const collapsed = one.match(/DEPT\.\s*NUMBER:\s*ORDER\s*NUMBER:\s*(\d{7,18})/i)?.[1] || null;
  const tableOrder = one.match(/Order\s*Number\s*Ship\s*Date\s*Cancel\s*Date\s*Freight\s*Allowance\s*(\d{5,12})/i)?.[1]
    || one.match(/BulkDomestic-\d+-(\d{5,12})\b/i)?.[1]
    || poFromFilename
    || null;

  if (collapsed && tableOrder && collapsed.endsWith(tableOrder)) {
    const dept = collapsed.slice(0, -tableOrder.length);
    return { deptFromFilename, deptFromPdf: dept, orderFromPdf: tableOrder, deptNo: dept, orderNo: tableOrder };
  }

  const deptFromPdf = one.match(/DEPT\.\s*NUMBER:\s*(\d{1,6})\b/i)?.[1] || null;
  const orderFromPdf = one.match(/ORDER\s*NUMBER:\s*(\d{5,12})\b/i)?.[1] || tableOrder || null;

  return {
    deptFromFilename,
    deptFromPdf,
    orderFromPdf,
    deptNo: deptFromPdf || deptFromFilename || null,
    orderNo: orderFromPdf || poFromFilename || null
  };
}

function extractDates(text) {
  const one = compactText(text);
  let orderDate = one.match(/Order Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] || null;
  let shipDate = one.match(/Ship Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] || null;
  let cancelDate = one.match(/Cancel Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)?.[1] || null;

  const oldBulk = one.match(/Cancel Date:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (oldBulk) {
    cancelDate = cancelDate || oldBulk[1];
    shipDate = shipDate || oldBulk[2];
    orderDate = orderDate || oldBulk[3];
  }

  const table = one.match(/Order\s*Number\s*Ship\s*Date\s*Cancel\s*Date\s*Freight\s*Allowance\s*\d{5,12}\s*(\d{1,2}\/\d{1,2}\/\d{4})\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (table) {
    shipDate = shipDate || table[1];
    cancelDate = cancelDate || table[2];
  }

  return {
    order_date: normalizeDate(orderDate),
    start_date: normalizeDate(shipDate),
    cancel_date: normalizeDate(cancelDate)
  };
}

function extractStore(text) {
  const one = compactText(text);

  // IMPORTANT: read center/address first. Do not scan after a generic Store: label,
  // because the next 3-digit token can be a color such as 003.
  return one.match(/LOGISTICS\s+SUPPORT\s+CENTER\s+#(\d{3,5})/i)?.[1]
    || one.match(/DIST\s+CENTER\s+#(\d{3,5})/i)?.[1]
    || one.match(/Ship\s*To:\s*Bealls\s*Stores\s*(\d{3,5})/i)?.[1]
    || one.match(/Mark\s*For:.*?#(\d{3,5})/i)?.[1]
    || null;
}

function extractTerms(text) {
  return compactText(text).match(/\b(ROG\s*NET\s*\d+)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
}

function parseSkuWindow(rawLines, startIndex) {
  const first = rawLines[startIndex];
  const starts = first.match(/^(\d{5,12})\b\s*(.*)$/);
  if (!starts) return null;

  const window = rawLines.slice(startIndex, startIndex + 6).join(' ');
  const tokens = window.split(/\s+/).filter(Boolean);
  if (!tokens.length || !isSkuToken(tokens[0])) return null;

  const customerSku = tokens[0];
  let cursor = 1;
  let styleRaw = tokens[cursor] || '';
  cursor += 1;

  // Style can be split in two ways:
  // 1) same text flow: EHH108-26- EVP Black Tattoo . Eve Twill Tote $11.00 100
  // 2) next visual row: EHH108-26- Black Tattoo . Eve Twill Tote $11.00 100 / EVP
  // Never consume visual color words such as Black/Dove/Khaki as a style suffix.
  if (
    styleRaw.endsWith('-') &&
    tokens[cursor] &&
    isSuffixToken(tokens[cursor]) &&
    !isVisualColorStart(tokens[cursor]) &&
    tokens[cursor + 1] &&
    !isSizeToken(tokens[cursor + 1])
  ) {
    styleRaw = `${styleRaw}${tokens[cursor]}`;
    cursor += 1;
  }

  let sizeIndex = -1;
  for (let i = cursor + 1; i < tokens.length; i += 1) {
    if (isSizeToken(tokens[i]) && tokens.slice(cursor, i).length > 0) {
      // A size token must be followed by a description and a price in the next tokens.
      const hasPriceAfter = tokens.slice(i + 1, i + 12).some(isPriceToken);
      if (hasPriceAfter) { sizeIndex = i; break; }
    }
  }
  if (sizeIndex < 0) return null;

  const colorRaw = tokens.slice(cursor, sizeIndex).join(' ');
  const sizeRaw = tokens[sizeIndex];

  // Some extractors put the style suffix BELOW the row, not immediately after style:
  // 99153227 EHH108-26- Black Tattoo . Eve Twill Tote $11.00 100
  // EVP
  // 159556 ABH4303E-42 Black . NYLON SQUARE SPACE WEEKENDER BAG W FLAT POUCH $9.00 463
  // -003
  const nextSuffix = suffixLineAfterRow(rawLines, startIndex);
  if (nextSuffix) styleRaw = appendStyleSuffix(styleRaw, nextSuffix);

  let priceIndex = -1;
  for (let i = sizeIndex + 1; i < tokens.length; i += 1) {
    if (isPriceToken(tokens[i])) { priceIndex = i; break; }
  }
  if (priceIndex < 0 || !tokens[priceIndex + 1] || !isQtyToken(tokens[priceIndex + 1])) return null;

  const description = tokens.slice(sizeIndex + 1, priceIndex).join(' ');
  if (!description || /^Total$/i.test(description)) return null;

  return {
    customer_sku: customerSku,
    style_raw: styleRaw,
    color_raw: colorRaw,
    size_raw: sizeRaw,
    description,
    sales_price: money(tokens[priceIndex]),
    qty_total: int(tokens[priceIndex + 1]),
    raw_source: rawLines.slice(startIndex, startIndex + 6),
    source_strategy: 'bealls_token_window_v20'
  };
}

function isLikelyBeallsTableRow(row) {
  if (!row) return false;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(row.style_raw || ''))) return false;
  const color = tokenClean(row.color_raw).toUpperCase();
  if (/\bSKU\b|MFG STYLE|MFG COLOR|TOTAL UNITS|FREIGHT ALLOWANCE/.test(color)) return false;
  if (!row.description || row.sales_price === null || row.qty_total === null) return false;
  return true;
}

function parseRowsFromLines(text) {
  const rawLines = linesOf(text);
  const rows = [];
  const seen = new Set();

  for (let i = 0; i < rawLines.length; i += 1) {
    let row = null;
    let packRaw = null;
    if (/^\d{5,12}\b/.test(rawLines[i])) {
      row = parseSkuWindow(rawLines, i);
    } else {
      const packMatch = rawLines[i].match(/^([A-Z0-9]{1,3})\s+(\d{5,12})\b\s*(.*)$/i);
      if (packMatch) {
        packRaw = packMatch[1];
        const synthetic = [`${packMatch[2]} ${packMatch[3]}`, ...rawLines.slice(i + 1, i + 6)];
        row = parseSkuWindow(synthetic, 0);
      }
    }
    if (!isLikelyBeallsTableRow(row)) continue;
    if (packRaw) row.pack_raw = packRaw;
    const key = [row.customer_sku, row.style_raw, row.color_raw, row.size_raw, row.sales_price, row.qty_total, row.description].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }

  return rows;
}

function parseRowsFromCompactText(text) {
  const one = compactText(text);
  const rows = [];
  const seen = new Set();

  // Fallback for completely collapsed rows without line breaks:
  // 99134190TSG1R01-G02Black.BLACK SUNGLASS SMART EYEWEAR$13.0086
  // 159544 AB101-42- Black . NYLON DIAMOND QUILT DUFFLE BAG $9.00 908
  const collapsed = /(\d{5,12})\s*([A-Z0-9]+(?:[\/A-Z0-9]*)(?:-[A-Z0-9\/]+)*-?)(?:\s+)?([A-Z0-9]{2,8})?\s*(Black|Brown Multi|Pink\/Black|Red\/Black|Pink|Brown|Red|White|Blue|Multi)\s*(\.|\d{1,3}[A-Z]?)\s+(.+?)\s*\$\s*(\d+(?:\.\d{2})?)(\d{1,6})\b/gi;
  let m;
  while ((m = collapsed.exec(one)) !== null) {
    let styleRaw = m[2];
    let colorRaw = m[4];
    if (styleRaw.endsWith('-') && m[3]) styleRaw = `${styleRaw}${m[3]}`;
    const row = {
      customer_sku: m[1],
      style_raw: styleRaw,
      color_raw: colorRaw,
      size_raw: m[5],
      description: tokenClean(m[6]),
      sales_price: money(m[7]),
      qty_total: int(m[8]),
      raw_source: [m[0]],
      source_strategy: 'bealls_compact_v20'
    };
    const key = [row.customer_sku, row.style_raw, row.color_raw, row.size_raw, row.sales_price, row.qty_total, row.description].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rows;
}

function rowsToLines(rows) {
  const groups = new Map();

  for (const row of rows) {
    const styleRaw = normalizeStyleRaw(row.style_raw);
    const colorRaw = tokenClean(row.color_raw) || null;
    const sizeRaw = tokenClean(row.size_raw) || null;
    if (!styleRaw) continue;

    // RAW parser grouping preserves every printed dimension. No historical/PT
    // mapping, visual-color fallback, or final A2000 style/color decision occurs here.
    const key = [styleRaw, colorRaw, sizeRaw, row.sales_price].join('|');
    if (!groups.has(key)) {
      groups.set(key, {
        style_raw: styleRaw,
        color_raw: colorRaw,
        size_raw: sizeRaw,
        description: row.description,
        sales_price: row.sales_price,
        qty_total: 0,
        customer_sku: row.customer_sku || null,
        sourceRows: []
      });
    }
    const group = groups.get(key);
    group.qty_total += Number(row.qty_total || 0);
    group.sourceRows.push(row);
  }

  let lineNo = 1;
  return [...groups.values()].map((group) => ({
    line_no: lineNo++,
    customer_sku: group.customer_sku,
    ticket_sku: null,
    upc: null,
    style_raw: group.style_raw,
    style_code: null,
    color_raw: group.color_raw,
    color_code: null,
    size_raw: group.size_raw,
    size_code: null,
    description: group.description,
    sales_price: group.sales_price,
    list_price: null,
    qty_total: group.qty_total,
    warehouse_code: null,
    raw: {
      source: 'bealls_v21_raw_master_only',
      vendor_style_raw: group.style_raw,
      style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED',
      style_similarity_semantics: 'NEAREST_OFFICIAL_STYLE_CODE',
      quantity_raw: group.qty_total,
      quantity_semantics: 'EACH',
      quantity_uom_raw: 'TOTAL UNITS',
      source_rows: group.sourceRows
    }
  }));
}

function extractBeallsLines(text) {
  const rows = [];
  const seen = new Set();
  const lineRows = parseRowsFromLines(text);
  // If normal line extraction works, do NOT also run compact extraction.
  // Compact fallback can over-match across several table rows and create ghost duplicates.
  const sourceRows = lineRows.length ? lineRows : parseRowsFromCompactText(text);
  for (const row of sourceRows) {
    const key = [row.customer_sku, row.style_raw, row.color_raw, row.sales_price, row.qty_total, row.description].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  return rowsToLines(rows);
}

export function parseBealls({ text, fileName }) {
  const rawText = cleanText(text || '');
  const oneLine = compactText(rawText);
  const { deptFromFilename, deptFromPdf, orderFromPdf, orderNo, deptNo } = extractDeptAndOrder(rawText, fileName || '');
  const dates = extractDates(rawText);
  const storeRaw = extractStore(rawText);
  const termsRaw = extractTerms(rawText);
  const totalQty = oneLine.match(/Total Qty\.\s*(\d[\d,]*)/i)?.[1] || null;
  const totalAmount = oneLine.match(/Total Cost\s*\$\s*([\d,]+\.\d{2})/i)?.[1] || null;
  const lines = extractBeallsLines(rawText);
  const customerRaw = tokenClean(oneLine.match(/\b(Bealls(?: Outlet)?(?: Stores)?)\b/i)?.[1]) || null;

  const warnings = [];
  if (deptFromFilename && deptFromPdf && deptFromFilename !== deptFromPdf) {
    warnings.push({ field: 'department', pdf: deptFromPdf, filename: deptFromFilename, message: 'Using PDF DEPT. NUMBER because filename may contain leading category/digit noise.' });
  }
  const poFromFilename = normalizeFileNameValue(fileName || '', 'PO');
  if (poFromFilename && orderFromPdf && poFromFilename !== orderFromPdf) {
    warnings.push({ field: 'order_no', pdf: orderFromPdf, filename: poFromFilename, message: 'Using PDF ORDER NUMBER because it is printed in the document.' });
  }

  const conflicts = [];
  const calculatedQty = lines.reduce((acc, line) => acc + Number(line.qty_total || 0), 0);
  const calculatedAmount = lines.reduce((acc, line) => acc + (Number(line.sales_price || 0) * Number(line.qty_total || 0)), 0);
  const printedQty = int(totalQty);
  const printedAmount = normalizeMoney(totalAmount);
  if (printedQty !== null && calculatedQty && printedQty !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed Bealls total quantity does not match extracted line quantities.', printed: printedQty, calculated: calculatedQty });
  }
  if (printedAmount !== null && calculatedAmount && Math.abs(printedAmount - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'totals.amount', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed Bealls total cost does not match extracted line amounts.', printed: printedAmount, calculated: Number(calculatedAmount.toFixed(2)) });
  }

  return {
    parser: 'bealls',
    document_family: 'bealls_purchase_order',
    layout_version: 'bealls_v21_raw_master_only',
    document_identity: {
      legal_entity_raw: customerRaw,
      brand_raw: customerRaw,
      customer_candidate: 'BEALLSOUTL',
      customer_candidate_source: 'document_family',
      a2000_customer_code: null
    },
    confidence: lines.length ? 0.99 : 0.6,
    header: {
      customer_raw: customerRaw,
      customer_code: null,
      order_no: orderNo,
      order_date: dates.order_date || null,
      start_date: dates.start_date || null,
      cancel_date: dates.cancel_date || null,
      book_date: null,
      dept_raw: deptNo,
      dept_code: null,
      division_code: null,
      store_raw: storeRaw,
      store_code: null,
      terms_raw: termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: { deptFromFilename, deptFromPdf, orderFromPdf, totalQty, totalAmount, warnings }
    },
    lines,
    totals: {
      qty: printedQty ?? calculatedQty ?? null,
      amount: printedAmount ?? (calculatedAmount ? Number(calculatedAmount.toFixed(2)) : null)
    },
    conflicts
  };
}
