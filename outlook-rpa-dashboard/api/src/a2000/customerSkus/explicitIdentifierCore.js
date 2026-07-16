import crypto from 'node:crypto';

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function firstValue(entries = []) {
  for (const entry of entries) {
    const value = clean(entry?.value);
    if (value) return { value, source: entry.source };
  }
  return { value: '', source: null };
}

function rawLine(line = {}) {
  return line.raw_json && typeof line.raw_json === 'object'
    ? line.raw_json
    : line.raw && typeof line.raw === 'object'
      ? line.raw
      : {};
}

function validCustomerUpc(value) {
  const normalized = clean(value).replace(/\s+/g, '');
  return /^\d{8,14}$/.test(normalized) ? normalized : '';
}

function citiSkuFromDetailLine(raw = {}) {
  const detail = clean(raw.detail_line || raw.source_detail_line);
  if (!detail) return '';

  const match = detail.match(
    /\b\d{4}-\d{6}-\d{7}-\d{4}-\d{5}\b/
  );

  return match?.[0] || '';
}

function citiUpcFromDetailLine(raw = {}) {
  const detail = clean(raw.detail_line || raw.source_detail_line);
  if (!detail) return '';

  const sku = citiSkuFromDetailLine(raw);
  const remainder = sku ? detail.replace(sku, ' ') : detail;
  const matches = remainder.match(/\b\d{8,14}\b/g) || [];
  return matches[0] || '';
}

function explicitRawText(raw = {}) {
  return [
    raw.detail_line,
    raw.source_detail_line,
    raw.source_line,
    raw.line_text,
    raw.raw_text,
    raw.customer_identifier_line,
    raw.sku_upc_line
  ].map(clean).filter(Boolean).join('\n');
}

function labeledCustomerSkuFromRaw(raw = {}) {
  const text = explicitRawText(raw);
  if (!text) return '';

  return text.match(
    /(?:CUSTOMER|CUST|RETAILER)\s*(?:SKU|ITEM(?:\s*(?:NO|NUMBER|#))?)\s*[:#=-]\s*([A-Z0-9][A-Z0-9._\/-]{2,50})/i
  )?.[1] || '';
}

function labeledCustomerUpcFromRaw(raw = {}) {
  const text = explicitRawText(raw);
  if (!text) return '';

  return text.match(
    /(?:CUSTOMER|CUST|RETAILER)\s*(?:UPC|GTIN|BARCODE)\s*[:#=-]\s*(\d{8,14})\b/i
  )?.[1] || '';
}

function rowValue(row = {}, names = []) {
  for (const name of names) {
    const value = row?.[name];
    if (value !== null && value !== undefined && clean(value)) {
      return value;
    }
  }
  return null;
}

function normalizePerSizeEntry(entry, fallbackSize = '') {
  if (entry === null || entry === undefined) return null;

  if (typeof entry === 'string' || typeof entry === 'number') {
    return {
      printed_size: clean(fallbackSize),
      customer_sku: clean(entry) || null,
      customer_upc: null,
      provenance: {
        customer_sku: 'per_size_scalar',
        customer_upc: null
      }
    };
  }

  if (typeof entry !== 'object') return null;

  const printedSize = clean(rowValue(entry, [
    'printed_size',
    'size_name',
    'size',
    'cust_size',
    'customer_size',
    'size_code'
  ]) || fallbackSize);
  const sku = clean(rowValue(entry, [
    'customer_sku',
    'cust_sku',
    'customer_item_number',
    'customer_item',
    'retailer_sku'
  ]));
  const upcCandidate = clean(rowValue(entry, [
    'customer_upc',
    'cust_upc',
    'explicit_customer_upc',
    'gtin',
    'barcode'
  ]));
  const upc = validCustomerUpc(upcCandidate);

  if (!sku && !upcCandidate) return null;

  return {
    printed_size: printedSize,
    customer_sku: sku || null,
    customer_upc: upc || null,
    invalid_customer_upc: Boolean(upcCandidate) && !upc,
    provenance: {
      customer_sku: sku ? 'per_size_explicit_row' : null,
      customer_upc: upc ? 'per_size_explicit_row' : null
    }
  };
}

function perSizeCandidates(line = {}, raw = {}) {
  const sources = [
    line.customer_identifiers_by_size,
    line.customer_skus_by_size,
    raw.customer_identifiers_by_size,
    raw.customer_skus_by_size,
    raw.customer_sku_rows,
    raw.customer_item_rows,
    raw.customer_sizes,
    raw.sizes
  ];
  const output = [];

  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const entry of source) {
        const normalized = normalizePerSizeEntry(entry);
        if (normalized) output.push(normalized);
      }
      continue;
    }

    if (source && typeof source === 'object') {
      for (const [size, entry] of Object.entries(source)) {
        const normalized = normalizePerSizeEntry(entry, size);
        if (normalized) output.push(normalized);
      }
    }
  }

  return output;
}

function uniqueIdentifierSets(rows = []) {
  const seen = new Set();
  const output = [];

  for (const row of rows) {
    const key = [
      clean(row.printed_size).toUpperCase(),
      clean(row.customer_sku),
      clean(row.customer_upc)
    ].join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }

  return output;
}

export function explicitCustomerIdentifierSets({
  customerCode,
  line
} = {}) {
  const raw = rawLine(line);
  const customer = clean(customerCode).toUpperCase();
  const bySize = perSizeCandidates(line, raw);

  if (bySize.length) {
    return uniqueIdentifierSets(bySize).map(row => ({
      ...row,
      forbidden_sources_not_used: [
        'ticket_sku',
        'master_upc',
        'internal_sku',
        'generic_upc',
        'style_code'
      ]
    }));
  }

  const sku = firstValue([
    { value: line?.customer_sku, source: 'purchase_order_lines.customer_sku' },
    { value: raw.customer_sku_raw, source: 'raw.customer_sku_raw' },
    { value: raw.customer_sku, source: 'raw.customer_sku' },
    { value: raw.cust_sku, source: 'raw.cust_sku' },
    { value: raw.customer_item_number, source: 'raw.customer_item_number' },
    { value: raw.retailer_sku, source: 'raw.retailer_sku' },
    {
      value: labeledCustomerSkuFromRaw(raw),
      source: 'raw.explicit_labeled_customer_sku'
    },
    customer === 'CITI'
      ? { value: citiSkuFromDetailLine(raw), source: 'CITI.detail_line.explicit_customer_sku' }
      : null
  ].filter(Boolean));

  const upcCandidate = firstValue([
    { value: line?.customer_upc, source: 'purchase_order_lines.customer_upc' },
    { value: raw.customer_upc_raw, source: 'raw.customer_upc_raw' },
    { value: raw.customer_upc, source: 'raw.customer_upc' },
    { value: raw.explicit_customer_upc, source: 'raw.explicit_customer_upc' },
    { value: raw.cust_upc, source: 'raw.cust_upc' },
    {
      value: labeledCustomerUpcFromRaw(raw),
      source: 'raw.explicit_labeled_customer_upc'
    },
    customer === 'CITI'
      ? { value: citiUpcFromDetailLine(raw), source: 'CITI.detail_line.explicit_customer_upc' }
      : null
  ].filter(Boolean));

  const upc = validCustomerUpc(upcCandidate.value);
  const printedSize = clean(
    line?.size_code
    || line?.size_raw
    || raw.customer_size_raw
    || raw.size_name
  );

  if (!sku.value && !upcCandidate.value) return [];

  return [{
    printed_size: printedSize,
    customer_sku: sku.value || null,
    customer_upc: upc || null,
    invalid_customer_upc: Boolean(upcCandidate.value) && !upc,
    provenance: {
      customer_sku: sku.value ? sku.source : null,
      customer_upc: upc ? upcCandidate.source : null
    },
    forbidden_sources_not_used: [
      'ticket_sku',
      'master_upc',
      'internal_sku',
      'generic_upc',
      'style_code'
    ]
  }];
}

export function explicitCustomerIdentifiers(options = {}) {
  const rows = explicitCustomerIdentifierSets(options);
  const row = rows[0] || {};

  return {
    customer_sku: row.customer_sku || null,
    customer_upc: row.customer_upc || null,
    printed_size: row.printed_size || null,
    provenance: row.provenance || {
      customer_sku: null,
      customer_upc: null
    },
    invalid_customer_upc: row.invalid_customer_upc === true,
    forbidden_sources_not_used: row.forbidden_sources_not_used || [
      'ticket_sku',
      'master_upc',
      'internal_sku',
      'generic_upc',
      'style_code'
    ]
  };
}

export function resolveA2000Size({
  skuRows = [],
  sizeRows = [],
  printedSize = ''
} = {}) {
  if (skuRows.length !== 1) {
    return {
      valid: false,
      code: skuRows.length === 0
        ? 'A2000_STYLE_COLOR_NOT_FOUND'
        : 'A2000_STYLE_COLOR_AMBIGUOUS'
    };
  }

  const explicitSize = clean(printedSize);

  if (sizeRows.length === 1) {
    const row = sizeRows[0];
    return {
      valid: true,
      size_name: clean(row.SIZE_NAME),
      size_num: Number(row.SIZE_NUM),
      pack_qty: Number(
        row.SCALE_PACK_QTY
        || skuRows[0].SCALE_PACK_QTY
        || 1
      ),
      inner_qty: 1,
      source: 'VR_UPC_STYLE_EXACT_SINGLE_SIZE'
    };
  }

  if (sizeRows.length > 1 && explicitSize && explicitSize !== '-') {
    const matches = sizeRows.filter(row => (
      clean(row.SIZE_NAME).toUpperCase()
      === explicitSize.toUpperCase()
      || clean(row.NRF_SIZE).toUpperCase()
        === explicitSize.toUpperCase()
    ));

    if (matches.length === 1) {
      const row = matches[0];
      return {
        valid: true,
        size_name: clean(row.SIZE_NAME),
        size_num: Number(row.SIZE_NUM),
        pack_qty: Number(
          row.SCALE_PACK_QTY
          || skuRows[0].SCALE_PACK_QTY
          || 1
        ),
        inner_qty: 1,
        source: 'VR_UPC_STYLE_EXACT_PRINTED_SIZE'
      };
    }
  }

  const sku = skuRows[0];
  const scale = clean(sku.SCALE || sku.SCALE_ABBR).toUpperCase();
  const scalePackQty = Number(sku.SCALE_PACK_QTY || 0);

  if (
    sizeRows.length === 0
    && scale === 'PC'
    && scalePackQty === 1
  ) {
    return {
      valid: true,
      size_name: 'PC',
      size_num: 1,
      pack_qty: 1,
      inner_qty: 1,
      source: 'VR_SKU_PC_SINGLE_SIZE_FALLBACK'
    };
  }

  return {
    valid: false,
    code: sizeRows.length > 1
      ? 'A2000_SIZE_AMBIGUOUS'
      : 'A2000_SIZE_NOT_FOUND'
  };
}

function rawForLine(line = {}) {
  return rawLine(line);
}

export function buildCustomerSkuUploadRow({
  order,
  line,
  identifiers,
  skuRow,
  sizeResolution
} = {}) {
  if (!identifiers?.customer_sku && !identifiers?.customer_upc) {
    return null;
  }

  const raw = rawForLine(line);
  const customer = clean(order?.customer_code);
  const style = clean(line?.style_code);
  const color = clean(line?.color_code);
  const customerStyle = firstValue([
    { value: raw.customer_style_raw, source: 'raw.customer_style_raw' },
    { value: raw.cust_style, source: 'raw.cust_style' },
    customer.toUpperCase() === 'CITI'
      ? { value: line?.style_raw, source: 'CITI.style_raw' }
      : null
  ].filter(Boolean)).value;
  const customerColor = firstValue([
    { value: raw.customer_color_raw, source: 'raw.customer_color_raw' },
    { value: raw.cust_color, source: 'raw.cust_color' },
    customer.toUpperCase() === 'CITI'
      ? {
          value: raw.customer_color_abbr
            || raw.color_abbr
            || raw.customer_color,
          source: 'CITI.customer_color'
        }
      : null
  ].filter(Boolean)).value;

  const row = {
    CUST_NO: customer,
    STYLE: style,
    COLOR_NO: color,
    SIZE_NAME: sizeResolution.size_name,
    SIZE_NUM: sizeResolution.size_num,
    CUST_SIZE: identifiers.printed_size
      && identifiers.printed_size !== '-'
      ? identifiers.printed_size
      : sizeResolution.size_name,
    CUST_SKU_DESCR: clean(line?.description),
    PACK_QTY: sizeResolution.pack_qty,
    INNER_QTY: sizeResolution.inner_qty
  };

  if (customerStyle) row.CUST_STYLE = customerStyle;
  if (customerColor) row.CUST_COLOR = customerColor;
  if (skuRow?.CLR_DESC) {
    row.CUST_COLOR_DESCR = clean(skuRow.CLR_DESC);
  }
  if (line?.description) {
    row.CUST_STYLE_DESCR = clean(line.description);
  }
  if (identifiers.customer_sku) {
    row.CUST_SKU = identifiers.customer_sku;
  }
  if (identifiers.customer_upc) {
    row.CUST_UPC = identifiers.customer_upc;
  }

  return row;
}

export function customerIdentifierPayloadHash(payload = {}) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}
