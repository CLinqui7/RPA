function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function finiteNumber(value) {
  const raw = clean(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function validCalendarDateParts(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidA2000DateValue(value) {
  const raw = clean(value);
  if (!raw) return false;
  let match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (match) return validCalendarDateParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return false;
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  return validCalendarDateParts(year, Number(match[1]), Number(match[2]));
}

export function explicitQtyBucketEntries(line = {}) {
  return Array.from({ length: 18 }, (_, index) => ({ bucket: index + 1, value: line[`qty_sz${index + 1}`] }));
}

export function hasExplicitA2000QtyBucket(line = {}) {
  return explicitQtyBucketEntries(line).some(({ value }) => clean(value) !== '');
}

export function invalidA2000QtyBuckets(line = {}) {
  return explicitQtyBucketEntries(line)
    .filter(({ value }) => clean(value) !== '')
    .filter(({ value }) => {
      const parsed = finiteNumber(value);
      return parsed === null || !Number.isInteger(parsed) || parsed < 0;
    });
}

export function hasPositiveA2000QtyBucket(line = {}) {
  if (invalidA2000QtyBuckets(line).length) return false;
  return explicitQtyBucketEntries(line).some(({ value }) => {
    const parsed = finiteNumber(value);
    return parsed !== null && parsed > 0;
  });
}

export function applyExplicitA2000QtyBuckets(row, line = {}) {
  for (const { bucket, value } of explicitQtyBucketEntries(line)) row[`QTY_SZ${bucket}`] = clean(value);
  return row;
}

export function blockingA2000Conflicts(entity = {}) {
  return (Array.isArray(entity.conflicts) ? entity.conflicts : []).filter((conflict) => {
    if (conflict?.blocking === false) return false;
    if (String(conflict?.severity || '').toLowerCase() === 'low') return false;
    return true;
  });
}

export function hasBlockingA2000Conflicts(entity = {}) {
  return blockingA2000Conflicts(entity).length > 0;
}

export function strictHeaderMissing(header = {}) {
  const missing = [];
  const required = [
    ['customer_code', header.customer_code], ['store_code', header.store_code], ['order_no', header.order_no],
    ['order_date', header.order_date], ['start_date', header.start_date], ['cancel_date', header.cancel_date],
    ['terms_code', header.terms_code], ['division_code', header.division_code], ['warehouse_code', header.warehouse_code]
  ];
  for (const [field, value] of required) if (!clean(value)) missing.push(field);

  const orderNo = clean(header.order_no);
  if (orderNo && orderNo.length > 25) missing.push('order_no_max_length');
  for (const field of ['order_date', 'start_date', 'cancel_date']) {
    const value = header[field];
    if (clean(value) && !isValidA2000DateValue(value)) missing.push(`${field}_invalid`);
  }
  return [...new Set(missing)];
}

export function strictLineMissing(header = {}, line = {}) {
  const missing = [];
  const lineNo = finiteNumber(line.line_no);
  if (lineNo === null || !Number.isInteger(lineNo) || lineNo <= 0) missing.push('line_no');
  if (!clean(line.style_code)) missing.push('style_code');
  if (!clean(line.color_code)) missing.push('color_code');

  // V4.7: SALES_PRICE is optional. Never synthesize zero. When present it must
  // still be a valid non-negative number.
  const salesPriceRaw = clean(line.sales_price);
  if (salesPriceRaw) {
    const salesPrice = finiteNumber(salesPriceRaw);
    if (salesPrice === null || salesPrice < 0) missing.push('sales_price_invalid');
  }

  if (!clean(line.warehouse_code || header.warehouse_code)) missing.push('warehouse_code');
  if (invalidA2000QtyBuckets(line).length) missing.push('qty_szn_invalid');
  if (!hasPositiveA2000QtyBucket(line)) missing.push('qty_szn');
  return [...new Set(missing)];
}

export function isStrictA2000Header(header = {}) {
  return strictHeaderMissing(header).length === 0;
}

export function isStrictA2000Line(header = {}, line = {}) {
  return strictLineMissing(header, line).length === 0;
}
