import { compactText, normalizeDate, normalizeInteger } from '../helpers.js';

function clean(value) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function linesOf(text) { return String(text || '').replace(/\u00a0/g, ' ').split(/\r?\n/).map((line) => line.replace(/\s+$/g, '')); }


function extractHeaderDates(rawLines) {
  const labelIndex = rawLines.findIndex((line) => /Dept\s*#\s+Order Date\s+Start Ship Date/i.test(line));
  if (labelIndex < 0) return { dept_raw: null, order_date_raw: null, start_date_raw: null, cancel_date_raw: null };
  for (const rawLine of rawLines.slice(labelIndex + 1, labelIndex + 7)) {
    const dates = [...String(rawLine || '').matchAll(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g)].map((match) => match[1]);
    if (dates.length < 3) continue;
    const dept = clean(String(rawLine || '').match(/^\s*([A-Z0-9-]+)\s+/i)?.[1]) || null;
    return { dept_raw: dept, order_date_raw: dates[0], start_date_raw: dates[1], cancel_date_raw: dates[2] };
  }
  return { dept_raw: null, order_date_raw: null, start_date_raw: null, cancel_date_raw: null };
}

function parseShipTo(rawLines) {
  const index = rawLines.findIndex((line) => /Ship Merchandise to:/i.test(line));
  if (index < 0) return null;
  const block = rawLines.slice(index + 1, index + 7).map(clean).filter(Boolean);
  const locationRaw = clean(block.find((value) => /^BRI:/i.test(value))?.replace(/^BRI:\s*/i, '')) || null;
  const dcRaw = clean(block.find((value) => /^DC\s*#:/i.test(value))?.match(/DC\s*#:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const address1 = block.find((value) => /^\d+\s+/.test(value)) || null;
  const cityState = block.find((value) => /^[A-Z .'-]+,\s*[A-Z]{2}$/i.test(value)) || null;
  const cityMatch = cityState?.match(/^(.+?),\s*([A-Z]{2})$/i);
  const postal = block.find((value) => /^\d{5}(?:-\d{4})?$/.test(value)) || null;
  return {
    semantics: 'SHIP_TO',
    location_name_raw: locationRaw,
    store_code_raw: dcRaw,
    name_raw: locationRaw ? `BRI: ${locationRaw}` : null,
    address1_raw: address1,
    city_raw: clean(cityMatch?.[1]) || null,
    state_raw: clean(cityMatch?.[2]).toUpperCase() || null,
    postal_raw: postal,
    block_raw: block
  };
}

export function parseMarshalls({ text }) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);
  const orderNo = clean(oneLine.match(/PO Number:\s*([A-Z0-9-]+)/i)?.[1]) || null;
  const versionRaw = clean(oneLine.match(/\bVersion:\s*([0-9]+)/i)?.[1]) || null;
  const versionDateRaw = clean(oneLine.match(/Version Date:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i)?.[1]) || null;
  const headerDates = extractHeaderDates(rawLines);
  const deptRaw = headerDates.dept_raw;
  const orderDateRaw = headerDates.order_date_raw;
  const startDateRaw = headerDates.start_date_raw;
  const cancelDateRaw = headerDates.cancel_date_raw;
  const shipTo = parseShipTo(rawLines);
  const lines = [];

  for (const rawLine of rawLines) {
    if (!/^\s*\d+-\d+\s{2,}/.test(rawLine)) continue;
    const cols = String(rawLine).trim().split(/\s{2,}/).map(clean).filter(Boolean);
    if (cols.length < 7) continue;
    const pgLnRaw = cols[0];
    const vendorStyleRaw = cols[1];
    const tjxStyleRaw = cols[2];
    const descriptionRaw = cols[3];
    const totalUnitsRaw = normalizeInteger(cols.at(-2));
    const dcUnitsRaw = normalizeInteger(cols.at(-1));
    let colorRaw = cols[4] || null;
    colorRaw = clean(colorRaw?.replace(/\s+0$/, '')) || null;
    if (!vendorStyleRaw || totalUnitsRaw === null) continue;
    lines.push({
      line_no: lines.length + 1,
      customer_sku: tjxStyleRaw || null,
      ticket_sku: null,
      upc: null,
      style_raw: vendorStyleRaw,
      style_code: null,
      color_raw: colorRaw,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: descriptionRaw || null,
      sales_price: null,
      list_price: null,
      qty_total: totalUnitsRaw,
      warehouse_code: null,
      raw: {
        source: 'marshalls_routing_distribution_instructions_v1',
        document_role: 'ROUTING_DISTRIBUTION_INSTRUCTIONS',
        page_line_raw: pgLnRaw,
        vendor_style_raw: vendorStyleRaw,
        composite_style_color_semantics: 'STYLE_COLOR_SUFFIX',
        tjx_style_raw: tjxStyleRaw || null,
        description_raw: descriptionRaw || null,
        color_raw: colorRaw,
        total_units_raw: totalUnitsRaw,
        dc_units_raw: dcUnitsRaw,
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'TOTAL UNITS',
        unit_cost_absent_in_source: true,
        size_ratio_absent_in_source: true,
        matched_text: clean(rawLine)
      }
    });
  }

  const calculatedQty = lines.reduce((sum, line) => sum + (Number(line.qty_total) || 0), 0) || null;
  const conflicts = [];
  const warnings = [];
  if (lines.length) {
    warnings.push({
      field: 'document_role', code: 'routing_document_missing_sales_order_fields', severity: 'medium', blocking: false,
      message: 'This source is a TJX Routing and Distribution Instructions document. It prints vendor style and total units, but not unit cost or size ratio. Missing A2000 fields are intentionally left unresolved.'
    });
  }

  return {
    parser: 'marshalls',
    document_family: 'tjx_marshalls_routing_distribution_instructions',
    layout_version: 'marshalls_routing_distribution_v1',
    document_identity: { legal_entity_raw: clean(oneLine.match(/An Affiliate of The\s+(TJX Companies, Inc\.)/i)?.[1]) || null, brand_raw: null, customer_candidate: 'MARSHALLS', customer_candidate_source: 'document_family_signature', a2000_customer_code: null },
    confidence: orderNo && lines.length ? 0.97 : lines.length ? 0.8 : 0.4,
    header: {
      customer_raw: null, customer_code: null, order_no: orderNo,
      order_date: normalizeDate(orderDateRaw), start_date: normalizeDate(startDateRaw), cancel_date: normalizeDate(cancelDateRaw), book_date: null,
      dept_raw: deptRaw, dept_code: null, division_code: null,
      store_raw: clean(shipTo?.store_code_raw) || null, store_code: null,
      terms_raw: null, terms_code: null, ship_via_code: null, warehouse_code: null,
      raw: { document_role: 'ROUTING_DISTRIBUTION_INSTRUCTIONS', version_raw: versionRaw, version_date_raw: versionDateRaw, dept_raw: deptRaw, order_date_raw: orderDateRaw, start_ship_date_raw: startDateRaw, cancel_date_raw: cancelDateRaw, ship_to: shipTo }
    },
    lines,
    totals: { qty: calculatedQty },
    conflicts,
    warnings
  };
}
