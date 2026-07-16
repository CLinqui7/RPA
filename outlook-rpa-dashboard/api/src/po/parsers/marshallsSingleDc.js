import {
  compactText,
  normalizeDate,
  normalizeInteger
} from '../helpers.js';

function clean(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function linesOf(text) {
  return String(text || '')
    .replace(/\u00a0/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+$/g, ''));
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function uniqueDcCodes(text = '') {
  return unique(
    [...String(text).matchAll(
      /\bDC\s*#\s*:?\s*([A-Z0-9-]+)/gi
    )]
      .map(match => clean(match[1]).toUpperCase())
  );
}

function extractHeader(rawLines, oneLine) {
  const headerBoundary = rawLines.findIndex(
    line => /Special Vendor Instructions/i.test(line)
  );

  const candidates = rawLines.slice(
    0,
    headerBoundary > 0 ? headerBoundary : 40
  );

  for (const rawLine of candidates) {
    const dates = [
      ...String(rawLine).matchAll(
        /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g
      )
    ].map(match => match[1]);

    if (dates.length < 3) continue;

    const firstDateIndex = String(rawLine).indexOf(dates[0]);
    const beforeDate = (
      firstDateIndex >= 0
        ? String(rawLine).slice(0, firstDateIndex)
        : ''
    );

    const deptRaw = clean(
      [...beforeDate.matchAll(/\b(\d{1,4})\b/g)]
        .map(match => match[1])
        .at(-1)
    ) || null;

    return {
      dept_raw: deptRaw,
      order_date_raw: dates[0],
      start_date_raw: dates[1],
      cancel_date_raw: dates[2]
    };
  }

  const dates = [
    ...String(oneLine).matchAll(
      /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g
    )
  ].map(match => match[1]);

  return {
    dept_raw: clean(
      String(oneLine).match(
        /Dept\s*#.*?\b(\d{1,4})\b\s+\d{1,2}\/\d{1,2}\/\d{4}/i
      )?.[1]
    ) || null,
    order_date_raw: dates[0] || null,
    start_date_raw: dates[1] || null,
    cancel_date_raw: dates[2] || null
  };
}

function extractShipTo(rawLines, oneLine, orderNo) {
  const dcCodes = uniqueDcCodes(oneLine);

  if (dcCodes.length !== 1) {
    return {
      dc_count: dcCodes.length,
      dc_codes: dcCodes,
      ship_to: null
    };
  }

  const dcCode = dcCodes[0];

  const dcIndex = rawLines.findIndex(
    line => new RegExp(
      `\\bDC\\s*#\\s*:?\\s*${dcCode}\\b`,
      'i'
    ).test(line)
  );

  const blockStart = dcIndex >= 0
    ? Math.max(0, dcIndex - 3)
    : 0;

  const block = dcIndex >= 0
    ? rawLines
        .slice(blockStart, dcIndex + 6)
        .map(clean)
        .filter(Boolean)
    : [];

  const locationLine = (
    block.find(value => /^[A-Z]{2,6}:\s*\S+/i.test(value))
    || clean(
      String(oneLine).match(
        /Ship Merchandise to:\s*([A-Z]{2,6}:\s*.*?)\s+DC\s*#/i
      )?.[1]
    )
    || null
  );

  const locationMatch = locationLine?.match(
    /^([A-Z]{2,6}):\s*(.+)$/i
  );

  const address1 = (
    block.find(value => /^\d+\s+/.test(value))
    || null
  );

  const cityState = (
    block.find(
      value => /^[A-Z .'-]+,\s*[A-Z]{2}$/i.test(value)
    )
    || null
  );

  const cityMatch = cityState?.match(
    /^(.+?),\s*([A-Z]{2})$/i
  );

  const postal = (
    block.find(
      value => /^\d{5}(?:-\d{4})?$/.test(value)
    )
    || null
  );

  const prefixMatch = String(oneLine).match(
    new RegExp(
      `PO\\s*#\\s*:?\\s*([A-Z0-9-]{1,4})\\s+${orderNo}\\b`,
      'i'
    )
  );

  return {
    dc_count: 1,
    dc_codes: [dcCode],
    ship_to: {
      semantics: 'SHIP_TO',
      location_code_raw:
        clean(locationMatch?.[1]).toUpperCase() || null,
      location_name_raw:
        clean(locationMatch?.[2]) || null,
      store_code_raw: dcCode,
      name_raw: locationLine,
      address1_raw: address1,
      city_raw: clean(cityMatch?.[1]) || null,
      state_raw:
        clean(cityMatch?.[2]).toUpperCase() || null,
      postal_raw: postal,
      po_prefix_raw:
        clean(prefixMatch?.[1]) || null,
      block_raw: block
    }
  };
}

function parseItemRows(rawLines, dcCode) {
  const parsed = [];

  for (const rawLine of rawLines) {
    if (!/^\s*\d+[-/]\d+\s{2,}/.test(rawLine)) {
      continue;
    }

    const columns = String(rawLine)
      .trim()
      .split(/\s{2,}/)
      .map(clean)
      .filter(Boolean);

    if (columns.length < 7) continue;

    const pageLineRaw = columns[0];
    const vendorStyleRaw = columns[1];
    const tjxStyleRaw = columns[2];

    if (!/^\d+[-/]\d+$/.test(pageLineRaw)) continue;
    if (!vendorStyleRaw || !tjxStyleRaw) continue;

    const numericTail = [];

    for (let index = columns.length - 1; index >= 3; index -= 1) {
      const value = normalizeInteger(columns[index]);

      if (value === null) {
        if (numericTail.length) break;
        continue;
      }

      numericTail.unshift({
        index,
        value
      });
    }

    if (numericTail.length < 2) continue;

    const totalUnits = numericTail.at(-2).value;
    const dcUnits = numericTail.at(-1).value;

    if (
      totalUnits < 0
      || dcUnits < 0
      || dcUnits > totalUnits
    ) {
      continue;
    }

    const firstNumericIndex = numericTail[0].index;
    const middle = columns.slice(3, firstNumericIndex);

    const descriptionRaw = middle[0] || null;

    const colorCandidate = (
      middle
        .slice(1)
        .find(value => !/^\d+(?:\.\d+)?$/.test(value))
      || null
    );

    const colorRaw = clean(
      String(colorCandidate || '')
        .replace(/\s+0$/, '')
    ) || null;

    parsed.push({
      line_no: parsed.length + 1,
      customer_sku: tjxStyleRaw,
      ticket_sku: null,
      upc: null,
      style_raw: vendorStyleRaw,
      style_code: null,
      color_raw: colorRaw,
      color_code: null,
      size_raw: null,
      size_code: null,
      description: descriptionRaw,
      sales_price: null,
      list_price: null,
      qty_total: dcUnits,
      qty_sz1: dcUnits,
      warehouse_code: null,
      raw: {
        source:
          'marshalls_single_dc_distribution_v2',
        document_role:
          'ROUTING_DISTRIBUTION_INSTRUCTIONS',
        page_line_raw: pageLineRaw,
        page_line_separator:
          pageLineRaw.includes('/') ? 'slash' : 'hyphen',
        vendor_style_raw: vendorStyleRaw,
        tjx_style_raw: tjxStyleRaw,
        description_raw: descriptionRaw,
        color_raw: colorRaw,
        printed_total_units_raw: totalUnits,
        destination_dc_units_raw: dcUnits,
        distribution_quantities_all_centers: {
          [dcCode]: dcUnits
        },
        quantity_semantics: 'EACH',
        quantity_uom_raw: 'TOTAL UNITS',
        unit_cost_absent_in_source: true,
        size_ratio_absent_in_source: true,
        matched_text: clean(rawLine)
      }
    });
  }

  return parsed;
}

export function parseMarshallsSingleDc({
  text,
  fileName
}) {
  const rawLines = linesOf(text);
  const oneLine = compactText(text);

  const orderNo = clean(
    oneLine.match(
      /PO Number:\s*([A-Z0-9-]+)/i
    )?.[1]
  ) || null;

  const versionRaw = clean(
    oneLine.match(
      /\bVersion:\s*([0-9]+)/i
    )?.[1]
  ) || null;

  const versionDateRaw = clean(
    oneLine.match(
      /Version Date:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i
    )?.[1]
  ) || null;

  const headerSource = extractHeader(
    rawLines,
    oneLine
  );

  const shipToResult = extractShipTo(
    rawLines,
    oneLine,
    orderNo
  );

  const dcCode = (
    shipToResult.ship_to?.store_code_raw
    || null
  );

  const lines = dcCode
    ? parseItemRows(rawLines, dcCode)
    : [];

  const calculatedQty = (
    lines.reduce(
      (sum, line) => sum + Number(line.qty_total || 0),
      0
    )
    || null
  );

  const conflicts = [];

  if (shipToResult.dc_count !== 1) {
    conflicts.push({
      field: 'store_code',
      code: 'single_dc_parser_requires_exactly_one_dc',
      severity: 'high',
      blocking: true,
      detected_dc_codes: shipToResult.dc_codes,
      message:
        'The single-DC Marshalls parser requires exactly one unique printed DC code.'
    });
  }

  if (!lines.length) {
    conflicts.push({
      field: 'lines',
      code: 'marshalls_single_dc_no_item_rows',
      severity: 'high',
      blocking: true,
      message:
        'No Marshalls item row matched the strict PG/LN, style, TJX style, total units and DC units structure.'
    });
  }

  return {
    parser: 'marshalls',
    document_family:
      'tjx_marshalls_routing_distribution_instructions',
    layout_version:
      'marshalls_single_dc_distribution_v2',
    document_identity: {
      legal_entity_raw: clean(
        oneLine.match(
          /An Affiliate of The\s+(TJX Companies, Inc\.)/i
        )?.[1]
      ) || null,
      brand_raw: 'Marshalls',
      customer_candidate: 'MARSHALLS',
      customer_candidate_source:
        'strict_document_family_signature',
      a2000_customer_code: null
    },
    confidence:
      orderNo && dcCode && lines.length
        ? 0.99
        : 0.5,
    header: {
      customer_raw: 'Marshalls',
      customer_code: null,
      order_no: orderNo,
      order_date:
        normalizeDate(headerSource.order_date_raw),
      start_date:
        normalizeDate(headerSource.start_date_raw),
      cancel_date:
        normalizeDate(headerSource.cancel_date_raw),
      book_date: null,
      dept_raw: headerSource.dept_raw,
      dept_code: null,
      division_code: null,
      store_raw: dcCode,
      store_code: dcCode,
      terms_raw: null,
      terms_code: null,
      ship_via_code: null,
      warehouse_code: null,
      raw: {
        document_role:
          'ROUTING_DISTRIBUTION_INSTRUCTIONS',
        source_file_name: fileName || null,
        version_raw: versionRaw,
        version_date_raw: versionDateRaw,
        dept_raw: headerSource.dept_raw,
        order_date_raw:
          headerSource.order_date_raw,
        start_ship_date_raw:
          headerSource.start_date_raw,
        cancel_date_raw:
          headerSource.cancel_date_raw,
        ship_to: shipToResult.ship_to,
        source_order_no: orderNo,
        source_document_order_count: 1,
        source_document_order_index: 1,
        split_semantics:
          'ONE_SOURCE_PO_ONE_DISTRIBUTION_CENTER',
        order_instance_key:
          orderNo && dcCode
            ? `${orderNo}|DC:${dcCode}`
            : null
      }
    },
    lines,
    totals: {
      qty: calculatedQty,
      quantity_source:
        'MARSHALLS_SINGLE_DC_UNITS',
      distribution_center_code: dcCode,
      source_document_total_qty: calculatedQty,
      destination_dc_units_verified: Boolean(
        lines.length
        && lines.every(
          line =>
            Number(line.qty_total)
            === Number(
              line.raw?.printed_total_units_raw
            )
        )
      )
    },
    conflicts,
    warnings: lines.length
      ? [{
          field: 'document_role',
          code:
            'marshalls_single_dc_order',
          severity: 'low',
          blocking: false,
          message:
            'One source PO contains exactly one Distribution Center and remains one internal order/control.'
        }]
      : []
  };
}

export function parseMarshalls(input) {
  return parseMarshallsSingleDc(input);
}
