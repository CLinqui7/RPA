import { compactText, normalizeDate, normalizeInteger, normalizeMoney } from '../helpers.js';

function clean(value = '') {
  const result = String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  return result || null;
}

function money(value) {
  return normalizeMoney(String(value || '').replace(/[$,]/g, ''));
}

function int(value) {
  return normalizeInteger(String(value || '').replace(/[,]/g, ''));
}

function normalizePoNumber(value) {
  return clean(value)?.toUpperCase() || null;
}

function parseGabesPoNumber(text, oneLine) {
  const patterns = [
    /Purchase\s+Order[\s\S]{0,350}?\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i,
    /(?:Customer\s+PO|P\.?O\.?|Order\s*#)\s*:?\s*\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i,
    /\b(\d{3}-\d{9,12}\s+[A-Z]{1,4})\b/i
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern) || String(oneLine || '').match(pattern);
    if (match?.[1]) return normalizePoNumber(match[1]);
  }
  return null;
}

function splitGabesPoNumber(value) {
  const raw = normalizePoNumber(value);
  const match = raw?.match(/^(\d{3})-(\d{9,12})\s+([A-Z]{1,4})$/i);
  return {
    order_no_raw: raw,
    prefix_raw: match?.[1] || null,
    numeric_body_raw: match?.[2] || null,
    suffix_raw: match?.[3]?.toUpperCase() || null
  };
}

function parseDates(oneLine) {
  const orderDate = oneLine.match(/Order\s+Date\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i)?.[1] || null;
  const shipCancel = oneLine.match(/Collect\s+(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i)
    || oneLine.match(/Ship\s+Date\s+Cancel\s+Date.*?(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  return { orderDate, shipDate: shipCancel?.[1] || null, cancelDate: shipCancel?.[2] || null };
}

function parseTerms(oneLine) {
  return oneLine.match(/\b(NET\s*\d+\s*DAYS)\b/i)?.[1]?.replace(/\s+/g, ' ').toUpperCase() || null;
}

function parseVendorId(oneLine) {
  return oneLine.match(/Vendor\s+ID:\s*([A-Z0-9]+)/i)?.[1] || null;
}

function parseVendorNo(oneLine) {
  return oneLine.match(/Revision:\s*\d+\s+Vendor:\s*(\d+)/i)?.[1]
    || oneLine.match(/\bVendor:\s*(\d+)\b/i)?.[1]
    || null;
}

function parseBrandRaw(pageLines = []) {
  const firstLines = pageLines.slice(0, 8).join(' ');
  return clean(firstLines.match(/\bGABE'?S\b/i)?.[0]) || null;
}

function parseShipTo(pageLines = []) {
  const markerIndex = pageLines.findIndex((line) => /Ship\s+To:/i.test(line));
  if (markerIndex < 0) return null;
  const markerColumn = pageLines[markerIndex].search(/Ship\s+To:/i);
  if (markerColumn < 0) return null;
  const values = [];
  for (let i = markerIndex + 1; i < Math.min(pageLines.length, markerIndex + 9); i += 1) {
    const line = pageLines[i];
    if (/^\s*Ship\s+Via\b/i.test(line) || /F\.O\.B\.\s+Terms/i.test(line)) break;
    const right = clean(line.slice(markerColumn));
    if (right) values.push(right);
  }
  const cityLineIndex = values.findIndex((value) => /,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/i.test(value));
  const cityMatch = cityLineIndex >= 0 ? values[cityLineIndex].match(/^(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\b/i) : null;
  const nameRaw = values[0] || null;
  const locationNameRaw = values[1] || null;
  const address1Raw = cityLineIndex > 1 ? values[cityLineIndex - 1] : null;
  return {
    semantics: 'SHIP_TO',
    name_raw: nameRaw,
    location_name_raw: locationNameRaw,
    address1_raw: address1Raw,
    city_raw: clean(cityMatch?.[1]) || null,
    state_raw: clean(cityMatch?.[2]) || null,
    postal_raw: clean(cityMatch?.[3]) || null,
    block_lines_raw: values
  };
}

function parseTotals(oneLine) {
  const match = oneLine.match(/Total\s+([\d,]+)\s+\$\s*([\d,]+\.\d{2})/i);
  return { qty: int(match?.[1]), amount: money(match?.[2]) };
}

function parsePoLines(oneLine) {
  const afterTableHeader = oneLine.split(/Internal\s+Item\s+#\s*\/\s*Ticket|Internal\s+Item\s+#/i).slice(-1)[0] || oneLine;
  const beforeFooter = afterTableHeader.split(/\bTotal\s+[\d,]+\s+\$/i)[0] || afterTableHeader;
  const rowPattern = /(\d{4}-\d{4}-\d{2}-\d-\d)\s+(\d{10})\s+(\d{1,3})\s+([\d,]+)\s+([A-Z0-9]+(?:-[A-Z0-9]+){1,4})\s+(.+?)\s+\$\s*(\d+(?:\.\d{2})?)\s+\$\s*([\d,]+\.\d{2})/gi;
  const lines = [];
  let match;
  while ((match = rowPattern.exec(beforeFooter)) !== null) {
    const customerSku = clean(match[1]);
    const ticketSku = clean(match[2]);
    const csPack = int(match[3]);
    const qty = int(match[4]);
    const poStyle = clean(match[5])?.toUpperCase() || null;
    const poDescription = clean(match[6]);
    const unitCost = money(match[7]);
    const extCost = money(match[8]);
    lines.push({
      line_no: lines.length + 1,
      customer_sku: customerSku,
      ticket_sku: ticketSku,
      upc: null,
      style_raw: poStyle,
      style_code: null,
      color_raw: null,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: poDescription,
      list_price: null,
      sales_price: unitCost,
      qty_total: qty,
      warehouse_code: null,
      raw: {
        source: 'gabes_purchase_order_v2_master_only',
        internal_item_raw: customerSku,
        ticket_sku_raw: ticketSku,
        po_style_raw: poStyle,
        style_resolution_hint: poStyle ? 'EXACT_MASTER_STYLE_NORMALIZED' : null,
        po_description_raw: poDescription,
        description_color_semantics: 'ABBREVIATED_OFFICIAL_COLOR_DESCRIPTION',
        color_code_format_preference: 'ALPHA_ALL_SIZE_FOR_PREPACK',
        case_pack_raw: csPack,
        quantity_raw: qty,
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'TOTAL QTY',
        unit_cost_raw: unitCost,
        ext_cost_raw: extCost
      }
    });
  }
  return lines;
}

function parseSupportingDocument({ text, oneLine }) {
  const isSupporting = /\bPick\s+Ticket\b/i.test(oneLine) || /\bPacking\s+Slip\b/i.test(oneLine) || /\bP\/T:\s*\d+/i.test(oneLine);
  if (!isSupporting) return null;
  return {
    pick_ticket_raw: oneLine.match(/(?:Pick\s+Ticket\s*#|P\/T:)\s*(\d{5,12})/i)?.[1] || null,
    control_no_raw: oneLine.match(/(?:Ctrl\s*#|Control\s+No\.:?)\s*(\d{5,12})/i)?.[1] || null,
    order_no_raw: parseGabesPoNumber(text, oneLine),
    warehouse_code_seen_raw: oneLine.match(/Warehouse\s*:\s*([A-Z0-9]+)/i)?.[1] || null,
    division_code_seen_raw: oneLine.match(/Div\s*#?\s*:\s*([A-Z0-9]+)/i)?.[1] || null,
    store_code_seen_raw: oneLine.match(/Store#\s*:\s*([A-Z0-9]+)/i)?.[1] || null
  };
}

export function parseGabes({ text }) {
  const rawText = String(text || '');
  const pageOne = rawText.split('\f')[0] || rawText;
  const pageLines = pageOne.split('\n');
  const oneLine = compactText(rawText);
  const brandRaw = parseBrandRaw(pageLines);
  const supporting = parseSupportingDocument({ text: rawText, oneLine });

  if (supporting) {
    return {
      parser: 'gabes',
      document_family: 'gabes_supporting_document',
      layout_version: 'gabes_supporting_document_v2_master_only',
      document_identity: { legal_entity_raw: null, brand_raw: brandRaw, customer_candidate: 'GABRIELBRO', customer_candidate_source: 'document_family_signature', a2000_customer_code: null },
      confidence: 0.4,
      header: {
        customer_raw: brandRaw, customer_code: null, order_no: supporting.order_no_raw,
        order_date: null, start_date: null, cancel_date: null, book_date: null,
        dept_raw: null, dept_code: null, division_code: null, store_raw: null, store_code: null,
        terms_raw: null, terms_code: null, ship_via_code: null, warehouse_code: null,
        raw: { source: 'gabes_supporting_document_v2_master_only', ...supporting }
      },
      lines: [], totals: {},
      conflicts: [{ field: 'document_type', code: 'supporting_document_not_purchase_order', severity: 'high', blocking: true, message: 'A Gabe\'s supporting document was detected. It is not eligible to create an order; use the Purchase Order PDF as the source document.' }],
      warnings: []
    };
  }

  const po = parseGabesPoNumber(rawText, oneLine);
  const poParts = splitGabesPoNumber(po);
  const dates = parseDates(oneLine);
  const terms = parseTerms(oneLine);
  const vendorId = parseVendorId(oneLine);
  const vendorNo = parseVendorNo(oneLine);
  const shipTo = parseShipTo(pageLines);
  const lines = parsePoLines(oneLine);
  const totals = parseTotals(oneLine);
  const calculatedQty = lines.reduce((sum, line) => sum + (line.qty_total || 0), 0) || null;
  const calculatedAmount = lines.reduce((sum, line) => sum + (line.raw?.ext_cost_raw || 0), 0) || null;
  const conflicts = [];

  if (totals.qty !== null && calculatedQty !== null && totals.qty !== calculatedQty) {
    conflicts.push({ field: 'totals.qty', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed Gabe\'s total quantity does not match extracted line quantities.', printed: totals.qty, calculated: calculatedQty });
  }
  if (totals.amount !== null && calculatedAmount !== null && Math.abs(totals.amount - calculatedAmount) > 0.01) {
    conflicts.push({ field: 'totals.amount', code: 'printed_total_mismatch', severity: 'high', blocking: true, message: 'Printed Gabe\'s total amount does not match extracted line extended costs.', printed: totals.amount, calculated: calculatedAmount });
  }

  return {
    parser: 'gabes',
    document_family: 'gabes_purchase_order',
    layout_version: 'gabes_vendor_original_v2_master_only',
    document_identity: { legal_entity_raw: null, brand_raw: brandRaw, customer_candidate: 'GABRIELBRO', customer_candidate_source: 'document_family_signature', a2000_customer_code: null },
    confidence: po && lines.length ? 0.95 : lines.length ? 0.75 : 0.45,
    header: {
      customer_raw: brandRaw,
      customer_code: null,
      order_no: po,
      order_date: normalizeDate(dates.orderDate),
      start_date: normalizeDate(dates.shipDate),
      cancel_date: normalizeDate(dates.cancelDate),
      book_date: null,
      dept_raw: null,
      dept_code: null,
      division_code: null,
      store_raw: null,
      store_code: null,
      terms_raw: terms,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        source: 'gabes_purchase_order_v2_master_only',
        vendor_id_raw: vendorId,
        vendor_number_raw: vendorNo,
        ship_to: shipTo,
        order_no_raw: poParts.order_no_raw,
        order_no_prefix_raw: poParts.prefix_raw,
        order_no_numeric_body_raw: poParts.numeric_body_raw,
        order_no_suffix_raw: poParts.suffix_raw,
        order_no_semantics: 'STRUCTURED_PRINTED_PO_PRESERVED'
      }
    },
    lines,
    totals: { qty: totals.qty, amount: totals.amount, calculated_qty: calculatedQty, calculated_amount: calculatedAmount },
    conflicts,
    warnings: []
  };
}
