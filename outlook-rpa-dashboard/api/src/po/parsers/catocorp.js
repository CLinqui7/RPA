import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';
import { customerHintFromDocument } from '../customerProfiles.js';

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeToken(value) {
  return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function linesOf(text) {
  return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, ''));
}

function numeric(value) {
  return normalizeMoney(String(value ?? '').replace(/,/g, ''));
}

function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseShipTo(oneLine) {
  const nameRaw = clean(oneLine.match(/Ship\s+to:\s*(CATO CORPORATION)/i)?.[1]) || null;
  const address1Raw = clean(oneLine.match(/\b(\d+\s+Denmark\s+Road)\b/i)?.[1]) || null;
  const cityPostal = oneLine.match(/\b(Charlotte)\s+NC\s+(\d{5})\b/i);
  if (!nameRaw || !address1Raw || !cityPostal) return null;
  return {
    semantics: 'SHIP_TO',
    name_raw: nameRaw,
    address1_raw: address1Raw,
    city_raw: clean(cityPostal[1]),
    state_raw: 'NC',
    postal_raw: clean(cityPostal[2]),
    block_raw: `${nameRaw} | ${address1Raw} | ${clean(cityPostal[1])}, NC ${clean(cityPostal[2])}`
  };
}

function parseSummaryItem(rawLines, startIndex, endIndex) {
  const heading = clean(rawLines[startIndex]);
  const vendorStyleRaw = clean(heading.match(/^Vendor Style\s+(.+?)\s+--\s+Color\/Size\/Diff Summary/i)?.[1]) || null;
  if (!vendorStyleRaw) return null;

  const blockLines = rawLines.slice(startIndex, endIndex);
  const qtyHeaderIndex = blockLines.findIndex((line) => /Qty\s+by\s+Size/i.test(line));
  let sizeHeaders = [];
  let colorRaw = null;
  let sizeGridEntries = [];
  let qtyTotal = null;

  if (qtyHeaderIndex >= 0) {
    const headerLine = blockLines.slice(qtyHeaderIndex + 1).find((line) => clean(line)) || '';
    sizeHeaders = String(headerLine).trim().split(/\s{2,}/).map(clean).filter((value) => value && !/^TOTAL$/i.test(value));
    const colorLine = blockLines.slice(qtyHeaderIndex + 2).find((line) => {
      const value = clean(line);
      return value && !/^Total\b/i.test(value) && /\d/.test(value);
    }) || '';
    const columns = String(colorLine).trim().split(/\s{2,}/).map(clean).filter(Boolean);
    const numericColumns = columns.filter((value) => /^-?[\d,]+(?:\.\d+)?$/.test(value)).map(numeric);
    const colorColumns = columns.filter((value) => !/^-?[\d,]+(?:\.\d+)?$/.test(value));
    colorRaw = clean(colorColumns.join(' ')) || null;
    if (numericColumns.length) qtyTotal = normalizeInteger(numericColumns.at(-1));
    const sizeQtyValues = numericColumns.slice(0, Math.min(sizeHeaders.length, Math.max(0, numericColumns.length - 1)));
    sizeGridEntries = sizeHeaders.map((size, index) => ({ size_raw: size, qty_raw: sizeQtyValues[index] ?? null })).filter((entry) => entry.qty_raw !== null);
  }

  return {
    line_no: null,
    customer_sku: null,
    ticket_sku: null,
    upc: null,
    style_raw: vendorStyleRaw,
    style_code: null,
    color_raw: colorRaw,
    color_code: null,
    size_raw: sizeHeaders.length === 1 ? sizeHeaders[0] : null,
    size_code: null,
    description: null,
    sales_price: null,
    list_price: null,
    qty_total: qtyTotal,
    warehouse_code: null,
    raw: {
      source: 'cato_corporation_purchase_order_v1',
      vendor_style_raw: vendorStyleRaw,
      style_resolution_hint: 'EXACT_MASTER_SKU_NORMALIZED',
      style_similarity_semantics: 'NEAREST_OFFICIAL_STYLE_CODE',
      composite_style_color_semantics: 'STYLE_COLOR_SUFFIX',
      color_raw: colorRaw,
      size_headers_raw: sizeHeaders,
      size_grid: sizeGridEntries.length ? { size_grid_entries_raw: sizeGridEntries } : null,
      quantity_raw: qtyTotal,
      quantity_semantics: 'EACH',
      quantity_uom_raw: 'ORDER QTY',
      matched_summary_heading: heading
    }
  };
}

function detailSections(rawLines) {
  const starts = [];
  rawLines.forEach((line, index) => {
    if (/Carton ID #/i.test(line) && /Vendor Style #/i.test(line)) starts.push(Math.max(0, index - 1));
  });
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : rawLines.findIndex((line, lineIndex) => lineIndex > start && /Order Total:/i.test(line));
    const sectionLines = rawLines.slice(start, end > start ? end : rawLines.length);
    const text = compactText(sectionLines.join('\n'));
    return { lines: sectionLines, text, token: normalizeToken(text) };
  });
}

function attachDetail(item, sections) {
  const styleToken = normalizeToken(item.style_raw);
  if (!styleToken) return item;
  const styleSegments = clean(item.style_raw).split('-').map(normalizeToken).filter((segment) => segment.length >= 2);
  const section = sections.find((candidate) => candidate.token.includes(styleToken))
    || sections.find((candidate) => styleSegments.length >= 2 && styleSegments.every((segment) => candidate.token.includes(segment)));
  if (!section) {
    item.raw.detail_resolution = { status: 'not_found', reason: 'vendor_style_not_found_in_detail_sections', vendor_style_raw: item.style_raw };
    return item;
  }

  const detailText = section.text;
  const eightDigitValues = [...detailText.matchAll(/\b(\d{8})\b/g)].map((match) => match[1]);
  const cartonIdRaw = eightDigitValues[0] || null;
  const catoStyleNumberRaw = eightDigitValues[1] || null;
  const skuRaw = eightDigitValues[2] || null;
  const qtyTotal = Number.isInteger(item.qty_total) ? item.qty_total : null;

  let costRaw = null;
  let extCostRaw = null;
  let retailRaw = null;
  if (qtyTotal !== null) {
    const costMatch = detailText.match(new RegExp(`\\b${qtyTotal}\\s+([\\d,.]+)\\s+([\\d,]+\\.\\d{2})\\s+([\\d,.]+)\\b`));
    costRaw = normalizeMoney(costMatch?.[1]);
    extCostRaw = normalizeMoney(costMatch?.[2]);
    retailRaw = normalizeMoney(costMatch?.[3]);
  }

  const deptRaw = clean(detailText.match(/\b(\d{3,5})\s+(\d{1,4})\s+V\s+[A-Za-z]+/i)?.[1]) || null;
  const classRaw = clean(detailText.match(/\b\d{3,5}\s+(\d{1,4})\s+V\s+[A-Za-z]+/i)?.[1]) || null;
  let descriptionRaw = null;
  if (catoStyleNumberRaw && deptRaw) {
    descriptionRaw = clean(detailText.match(new RegExp(`\\b${escapeRegex(catoStyleNumberRaw)}\\b\\s+(.+?)\\s+${escapeRegex(deptRaw)}\\s+${escapeRegex(classRaw || '')}\\s+V\\s+`, 'i'))?.[1]) || null;
  }

  item.customer_sku = catoStyleNumberRaw;
  item.description = descriptionRaw;
  item.sales_price = costRaw;
  item.raw = {
    ...item.raw,
    detail_resolution: { status: 'matched', reason: 'normalized_vendor_style_exact_in_detail_section', vendor_style_raw: item.style_raw },
    carton_id_raw: cartonIdRaw,
    cato_style_number_raw: catoStyleNumberRaw,
    sku_raw: skuRaw,
    dept_raw: deptRaw,
    class_raw: classRaw,
    description_raw: descriptionRaw,
    cost_raw: costRaw,
    ext_cost_raw: extCostRaw,
    retail_raw: retailRaw
  };
  return item;
}

function parseOrderChunk(chunk) {
  const rawLines = linesOf(chunk);
  const oneLine = compactText(chunk);
  const orderNo = clean(oneLine.match(/PURCHASE ORDER:\s*(\d{5,12})/i)?.[1]) || null;
  const orderDateRaw = clean(oneLine.match(/PO Date:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1]) || null;
  const deptRaw = clean(oneLine.match(/\bDept:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const shipWindowMatch = oneLine.match(/Contracted Ship Dates:\s*.*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  const termsRaw = clean(oneLine.match(/Payment Terms:\s*(\d+%\s+\d+\s+Days\s*\/\s*\d+%\s+Warehouse)/i)?.[1]) || null;
  const shipTo = parseShipTo(oneLine);
  const summaryStarts = [];
  rawLines.forEach((line, index) => {
    if (/^\s*Vendor Style\s+.+?--\s+Color\/Size\/Diff Summary\s*$/i.test(line)) summaryStarts.push(index);
  });
  const sections = detailSections(rawLines);
  const lines = [];
  for (let index = 0; index < summaryStarts.length; index += 1) {
    const start = summaryStarts[index];
    const next = index + 1 < summaryStarts.length ? summaryStarts[index + 1] : rawLines.length;
    const item = parseSummaryItem(rawLines, start, next);
    if (!item) continue;
    item.line_no = lines.length + 1;
    lines.push(attachDetail(item, sections));
  }
  const calculatedQty = lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (Number(line.raw?.ext_cost_raw) || 0), 0) || null;
  const printedOrderTotal = normalizeInteger(oneLine.match(/Order Total:\s*([\d,]+)/i)?.[1]);
  const conflicts = [];
  if (printedOrderTotal !== null && calculatedQty !== null && printedOrderTotal !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed Cato Order Total quantity does not match extracted line quantities.', printed: printedOrderTotal, extracted: calculatedQty });
  }
  return {
    orderNo, orderDateRaw, deptRaw,
    startDateRaw: clean(shipWindowMatch?.[1]) || null,
    cancelDateRaw: clean(shipWindowMatch?.[2]) || null,
    termsRaw, shipTo, lines, calculatedQty, calculatedAmount, conflicts
  };
}

function splitCatoOrderChunks(text) {
  const formFeedChunks = String(text || '').split(/\f+/).filter((chunk) => /PURCHASE ORDER:/i.test(chunk));
  if (formFeedChunks.length > 1) return formFeedChunks;

  // Some PDF engines collapse page breaks. In that case, every PURCHASE ORDER:
  // starts a new hardcopy/order. The standard Cato footer belongs to the current
  // segment and is naturally retained until the next PURCHASE ORDER marker.
  const source = String(text || '');
  const markers = [...source.matchAll(/PURCHASE ORDER:\s*\d{5,12}/gi)].map((match) => match.index).filter((index) => Number.isInteger(index));
  if (markers.length <= 1) return /PURCHASE ORDER:/i.test(source) ? [source] : [];
  return markers.map((marker, index) => source.slice(marker, markers[index + 1] ?? source.length));
}

function catoIdentity({ legalEntityRaw, hint }) {
  return {
    legal_entity_raw: legalEntityRaw,
    brand_raw: null,
    customer_candidate: hint?.code || null,
    customer_candidate_source: hint?.source || null,
    a2000_customer_code: null,
    upstream_customer_hint: hint || null,
    customer_candidates: ['CATO', 'ITSFASHION', 'VERSONA']
  };
}

function buildCatoParsedDocument({ order, fileName, legalEntityRaw, hint, sourceOrderIndex = 0, sourceOrderCount = 1 }) {
  const conflicts = [...(order.conflicts || [])];
  if (!hint) {
    conflicts.push({
      field: 'customer_code', code: 'cato_banner_identity_ambiguous', severity: 'high', blocking: true,
      message: 'The PDF identifies CATO CORPORATION but does not identify the A2000 banner/customer among CATO, ITSFASHION and VERSONA. Upstream email/document metadata must provide the customer candidate.',
      candidates: ['CATO', 'ITSFASHION', 'VERSONA']
    });
  }
  if (hint?.code === 'VERSONA' && order.orderNo) {
    conflicts.push({
      field: 'order_no', code: 'order_no_requires_business_review', severity: 'high', blocking: true,
      message: 'The printed Cato-family PURCHASE ORDER number is preserved, but business confirmed Versona order number ownership must be reviewed before A2000 export.',
      printed_order_no_raw: order.orderNo,
      customer_candidate: 'VERSONA'
    });
  }
  return {
    parser: 'catocorp',
    document_family: 'cato_corporation_purchase_order',
    layout_version: sourceOrderCount > 1 ? 'cato_corporation_po_v2_split' : 'cato_corporation_po_v1',
    document_identity: catoIdentity({ legalEntityRaw, hint }),
    confidence: order.orderNo && order.lines.length ? 0.97 : order.lines.length ? 0.8 : 0.4,
    header: {
      customer_raw: legalEntityRaw,
      customer_code: null,
      order_no: order.orderNo,
      order_date: normalizeDate(order.orderDateRaw),
      start_date: normalizeDate(order.startDateRaw),
      cancel_date: normalizeDate(order.cancelDateRaw),
      book_date: null,
      dept_raw: order.deptRaw,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: order.termsRaw,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        order_date_raw: order.orderDateRaw,
        contracted_ship_start_raw: order.startDateRaw,
        contracted_ship_end_raw: order.cancelDateRaw,
        dept_raw: order.deptRaw,
        payment_terms_raw: order.termsRaw,
        ship_to: order.shipTo,
        upstream_customer_hint: hint || null,
        source_file_name: clean(fileName) || null,
        multi_order_document: sourceOrderCount > 1,
        source_order_index: sourceOrderIndex + 1,
        source_order_count: sourceOrderCount,
        hardcopy_boundary_semantics: sourceOrderCount > 1 ? 'PURCHASE_ORDER_PAGE_OR_MARKER_SEGMENT' : 'SINGLE_PURCHASE_ORDER'
      }
    },
    lines: order.lines,
    totals: { qty: order.calculatedQty, amount: order.calculatedAmount },
    conflicts,
    warnings: []
  };
}

export function parseCatoCorpOrders({ text, fileName, document }) {
  const chunks = splitCatoOrderChunks(text);
  const parsedOrders = chunks.map(parseOrderChunk).filter((order) => order.orderNo || order.lines.length);
  const hint = customerHintFromDocument(document, ['CATO', 'ITSFASHION', 'VERSONA']);
  const legalEntityRaw = clean(compactText(text).match(/Ship\s+to:\s*(CATO CORPORATION)/i)?.[1]) || null;
  const sourceOrderCount = parsedOrders.length;
  if (!sourceOrderCount) {
    return [buildCatoParsedDocument({ order: parseOrderChunk(text), fileName, legalEntityRaw, hint, sourceOrderIndex: 0, sourceOrderCount: 1 })];
  }
  return parsedOrders.map((order, sourceOrderIndex) => buildCatoParsedDocument({
    order,
    fileName,
    legalEntityRaw,
    hint,
    sourceOrderIndex,
    sourceOrderCount
  }));
}

export function parseCatoCorp({ text, fileName, document }) {
  const parsedOrders = parseCatoCorpOrders({ text, fileName, document });
  if (parsedOrders.length <= 1) return parsedOrders[0];

  const hint = customerHintFromDocument(document, ['CATO', 'ITSFASHION', 'VERSONA']);
  const legalEntityRaw = clean(compactText(text).match(/Ship\s+to:\s*(CATO CORPORATION)/i)?.[1]) || null;
  const conflicts = [{
    field: 'order_no', code: 'multi_order_document_requires_split', severity: 'high', blocking: true,
    message: 'This Cato Corporation PDF contains multiple purchase orders. Use parsePurchaseOrders/parseCatoCorpOrders so every hardcopy segment becomes its own order.',
    order_numbers: parsedOrders.map((item) => item.header?.order_no).filter(Boolean),
    order_count: parsedOrders.length
  }];
  if (!hint) {
    conflicts.push({
      field: 'customer_code', code: 'cato_banner_identity_ambiguous', severity: 'high', blocking: true,
      message: 'The PDF identifies CATO CORPORATION but does not identify the A2000 banner/customer among CATO, ITSFASHION and VERSONA. Upstream email/document metadata must provide the customer candidate.',
      candidates: ['CATO', 'ITSFASHION', 'VERSONA']
    });
  }
  return {
    parser: 'catocorp', document_family: 'cato_corporation_purchase_order', layout_version: 'cato_corporation_po_v1_multi_order_legacy_block',
    document_identity: catoIdentity({ legalEntityRaw, hint }),
    confidence: 0.95,
    header: {
      customer_raw: legalEntityRaw, customer_code: null, order_no: null, order_date: null, start_date: null, cancel_date: null, book_date: null,
      dept_raw: null, dept_code: null, division_code: null, store_raw: null, store_code: null, terms_raw: null, terms_code: null,
      ship_via_code: null, warehouse_code: null,
      raw: {
        source_file_name: clean(fileName) || null,
        multi_order_document: true,
        detected_orders: parsedOrders.map((item) => ({ order_no: item.header?.order_no, line_count: item.lines?.length || 0, qty: item.totals?.qty }))
      }
    },
    lines: [], totals: { order_count: parsedOrders.length }, conflicts, warnings: []
  };
}
