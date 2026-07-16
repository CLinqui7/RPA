import crypto from 'node:crypto';

// A2000_BUSINESS_RULES_V2_INTEGRATED
import {
  resolveBackOrderForOrder,
  resolveCustomerSkuForLine,
  resolveSalesRepForOrder
} from './businessRules/index.js';

function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveQuantity(value) {
  const parsed = numeric(value);
  return parsed !== null && parsed > 0 ? parsed : 0;
}


export function officialMasterReferenceUpc(line = {}) {
  const raw = (
    line.raw_json
    && typeof line.raw_json === 'object'
  )
    ? line.raw_json
    : (
      line.raw
      && typeof line.raw === 'object'
        ? line.raw
        : {}
    );

  const identity = (
    raw.universal_official_master_identity
    && typeof raw.universal_official_master_identity === 'object'
  )
    ? raw.universal_official_master_identity
    : {};

  const candidate = clean(
    line.master_upc
    || raw.master_upc
    || identity.master_upc
  ).replace(/[^0-9]/g, '');

  const source = clean(
    line.master_upc_source
    || raw.master_upc_source
    || identity.master_upc_source
    || identity.source
  ).toUpperCase();

  const allowedSources = new Set([
    'VR_UPC_STYLE_UNIQUE_MASTER_UPC',
    'VR_UPC_STYLE_EXACT_UPC',
    'EXACT_OFFICIAL_UPC',
    'UNIQUE_MASTER_UPC',
    'VR_UPC_STYLE_EXACT_UNIQUE_UPC'
  ]);

  if (!/^\d{11,14}$/.test(candidate)) return '';
  if (!allowedSources.has(source)) return '';

  return candidate;
}

export function formatDateForA2000(value) {
  const raw = clean(value);
  if (!raw) return '';

  if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(raw)) return raw;
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) return raw;

  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [yyyy, mm, dd] = raw.slice(0, 10).split('-');
    return `${Number(mm)}/${Number(dd)}/${yyyy}`;
  }

  return raw;
}

export function quantitiesByBucket(line = {}) {
  const out = {};

  for (let bucket = 1; bucket <= 18; bucket += 1) {
    const quantity = positiveQuantity(line[`qty_sz${bucket}`]);
    if (quantity > 0) out[bucket] = quantity;
  }

  return out;
}

export function hasSizeDistribution(line = {}) {
  return Object.keys(quantitiesByBucket(line)).length > 0;
}

export function sizeDistributionTotal(line = {}) {
  return Object.values(quantitiesByBucket(line))
    .reduce((sum, value) => sum + Number(value || 0), 0);
}

export function normalizedRatioFromDistribution(line = {}) {
  const distribution = quantitiesByBucket(line);
  const values = Object
    .values(distribution)
    .map(value => Math.round(Number(value)));

  if (!values.length || values.some(value => value <= 0)) return {};

  function gcd(a, b) {
    let x = Math.abs(a);
    let y = Math.abs(b);

    while (y) {
      const temp = y;
      y = x % y;
      x = temp;
    }

    return x;
  }

  let divisor = values[0];

  for (const value of values.slice(1)) {
    divisor = gcd(divisor, value);
  }

  if (!divisor) return {};

  return Object.fromEntries(
    Object.entries(distribution)
      .map(([bucket, quantity]) => [
        bucket,
        Math.round(Number(quantity)) / divisor
      ])
  );
}

export function validateInternalOrder(order = {}) {
  const errors = [];
  const warnings = [];
  const requiredHeader = [
    ['customer_code', order.customer_code],
    ['store_code', order.store_code || order.store_raw],
    ['order_no', order.order_no],
    ['order_date', order.order_date],
    ['start_date', order.start_date],
    ['cancel_date', order.cancel_date],
    ['division_code', order.division_code],
    ['terms_code', order.terms_code],
  ];

  for (const [field, value] of requiredHeader) {
    if (!clean(value)) errors.push({ scope: 'header', field, message: 'Value is required for A2000 REST preflight.' });
  }

  if (clean(order.order_no).length > 25) {
    errors.push({ scope: 'header', field: 'order_no', message: 'A2000 ORDER_NO max length observed is 25.' });
  }

  const lines = Array.isArray(order.purchase_order_lines)
    ? order.purchase_order_lines
    : Array.isArray(order.lines) ? order.lines : [];

  const resolvedLineWarehouses = [
    ...new Set(
      lines
        .map(line => clean(line?.warehouse_code || order.warehouse_code))
        .filter(Boolean)
    )
  ];

  if (!clean(order.warehouse_code) && resolvedLineWarehouses.length > 1) {
    warnings.push({
      scope: 'header',
      code: 'MIXED_LINE_WAREHOUSES_HEADER_DEFAULT_OMITTED',
      warehouses: resolvedLineWarehouses,
      message: 'DEF_WHOUSE is omitted because this control contains multiple exact ORDER_LI WHOUSE values.'
    });
  }

  if (!lines.length) errors.push({ scope: 'lines', field: 'lines', message: 'At least one Sales Order Line is required.' });
  const seenLineNumbers = new Set();

  lines.forEach((line, index) => {
    const displayLine = line.line_no ?? index + 1;
    for (const [field, value] of [
      ['style_code', line.style_code],
      ['color_code', line.color_code],
      ['warehouse_code', line.warehouse_code || order.warehouse_code]
    ]) {
      if (!clean(value)) errors.push({ scope: 'line', line_no: displayLine, field, message: 'Value is required for A2000 ORDER_LI preflight.' });
    }

    const price = numeric(line.sales_price);
    if (clean(line.sales_price) && (price === null || price < 0)) {
      errors.push({ scope: 'line', line_no: displayLine, field: 'sales_price', message: 'SALES_PRICE must be numeric and non-negative when supplied.' });
    } else if (!clean(line.sales_price)) {
      warnings.push({
        scope: 'line',
        line_no: displayLine,
        code: 'SALES_PRICE_OMITTED',
        message: 'SALES_PRICE is absent and will be omitted from ORDER_LI rather than invented.'
      });
    }

    if (!hasSizeDistribution(line)) {
      errors.push({
        scope: 'line',
        line_no: displayLine,
        field: 'qty_size_distribution',
        message: 'A2000 ORDER_LI has no generic QTY_TOTAL field. At least one exact positive QTY_SZ1..QTY_SZ18 bucket is required for this upload adapter.'
      });
    }

    const bucketTotal = sizeDistributionTotal(line);
    const qtyTotal = numeric(line.qty_total);
    if (qtyTotal !== null && qtyTotal > 0 && Math.abs(bucketTotal - qtyTotal) > 0.000001) {
      errors.push({ scope: 'line', line_no: displayLine, field: 'qty_total', message: `qty_total=${qtyTotal} does not equal sum(qty_sz1..qty_sz18)=${bucketTotal}.` });
    }

    const lineNo = Number.parseInt(clean(displayLine), 10);
    if (!Number.isInteger(lineNo) || lineNo <= 0) {
      errors.push({ scope: 'line', line_no: displayLine, field: 'line_no', message: 'LINE_NO must be a positive integer.' });
    } else if (seenLineNumbers.has(lineNo)) {
      errors.push({ scope: 'line', line_no: displayLine, field: 'line_no', message: `Duplicate LINE_NO ${lineNo} in Internal Order.` });
    } else {
      seenLineNumbers.add(lineNo);
    }

    const ratio = normalizedRatioFromDistribution(line);
    if (Object.keys(ratio).length) warnings.push({
      scope: 'line',
      line_no: displayLine,
      code: 'NORMALIZED_RATIO_OBSERVED',
      normalized_ratio: ratio,
      message: 'Derived ratio is traceability only. Live VR_SKU_Z remains authoritative.'
    });
  });

  return { valid: errors.length === 0, errors, warnings, line_count: lines.length };
}

export function mapOrderHd(order = {}) {
  const row = {
    CUST_NO: clean(order.customer_code),
    STORE_NO: clean(order.store_code || order.store_raw),
    ORDER_NO: clean(order.order_no),
    ORDER_DATE: formatDateForA2000(order.order_date),
    START_DATE: formatDateForA2000(order.start_date),
    CANCEL_DATE: formatDateForA2000(order.cancel_date),
    DIV_NO: clean(order.division_code),
    TERM_NO: clean(order.terms_code),
    BACK_ORDER: resolveBackOrderForOrder(order).value,
    SMAN1_NO: resolveSalesRepForOrder(order).value
  };

  if (clean(order.ship_via_code)) {
    row.SHIP_VIA_NO = clean(order.ship_via_code);
  }

  if (clean(order.warehouse_code)) {
    row.DEF_WHOUSE = clean(order.warehouse_code);
  }

  if (clean(order.order_type)) {
    row.ORDER_TYPE = clean(order.order_type);
  }

  return row;
}

export function mapOrderLi(order = {}, line = {}, seqOrderNo, fallbackLineNo) {
  const row = {
    SEQ_ORDER_NO: Number(seqOrderNo),
    LINE_NO: Number(line.line_no || fallbackLineNo),
    CUST_NO: clean(order.customer_code),
    STORE_NO: clean(order.store_code || order.store_raw),
    ORDER_NO: clean(order.order_no),
    STYLE: clean(line.style_code),
    COLOR_NO: clean(line.color_code),
    WHOUSE: clean(line.warehouse_code || order.warehouse_code),
    CUST_STYLE1: resolveCustomerSkuForLine(line, order).value
  };

  const price = numeric(line.sales_price);
  if (price !== null && price >= 0) row.SALES_PRICE = price;

  const referenceUpc = officialMasterReferenceUpc(line);
  if (referenceUpc) row.REF = referenceUpc;

  const distribution = quantitiesByBucket(line);
  for (const [bucket, quantity] of Object.entries(distribution)) {
    row[`QTY_SZ${bucket}`] = quantity;
  }
  return row;
}

export function canonicalOrderForIdempotency(order = {}) {
  const lines = Array.isArray(order.purchase_order_lines)
    ? order.purchase_order_lines
    : Array.isArray(order.lines)
      ? order.lines
      : [];

  return {
    customer_code: clean(order.customer_code).toUpperCase(),
    store_code: clean(order.store_code || order.store_raw).toUpperCase(),
    order_no: clean(order.order_no),
    division_code: clean(order.division_code).toUpperCase(),
    order_date: clean(order.order_date),
    start_date: clean(order.start_date),
    cancel_date: clean(order.cancel_date),
    terms_code: clean(order.terms_code).toUpperCase(),
    warehouse_code: clean(order.warehouse_code).toUpperCase(),
    lines: lines
      .map((line, index) => ({
        line_no: Number(line.line_no || index + 1),
        style_code: clean(line.style_code).toUpperCase(),
        color_code: clean(line.color_code).toUpperCase(),
        sales_price: numeric(line.sales_price),
        warehouse_code: clean(
          line.warehouse_code || order.warehouse_code
        ).toUpperCase(),
        reference_upc: officialMasterReferenceUpc(line),
        quantities_by_bucket: quantitiesByBucket(line)
      }))
      .sort((left, right) => left.line_no - right.line_no)
  };
}

export function buildIdempotencyKey(order = {}) {
  const canonical = JSON.stringify(
    canonicalOrderForIdempotency(order)
  );

  return crypto
    .createHash('sha256')
    .update(canonical)
    .digest('hex');
}
