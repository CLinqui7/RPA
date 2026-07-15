import crypto from 'node:crypto';

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function safeFileToken(value, fallback = 'UNKNOWN') {
  const token = clean(value).replace(/[^A-Za-z0-9._-]+/g, '-');
  return token || fallback;
}

export function checklistInternalControlKey(order = {}) {
  return clean(
    order.order_instance_key
    || order.raw_json?.header?.raw?.order_instance_key
    || `${order.order_no || 'NO-PO'}|STORE:${order.store_code || order.store_raw || 'NO-STORE'}`
  );
}

export function checklistControlGroupKey(order = {}, canonicalCustomerCode = '') {
  const customer = clean(canonicalCustomerCode || order.customer_code).toUpperCase() || 'NO-CUSTOMER';
  return `${customer}|${checklistInternalControlKey(order)}`;
}

export function provisionalChecklistControlNo(order = {}) {
  const store = safeFileToken(order.store_code || order.store_raw, 'NO-STORE');
  const digest = crypto
    .createHash('sha256')
    .update(checklistInternalControlKey(order))
    .digest('hex')
    .slice(0, 8)
    .toUpperCase();

  return `PENDING-${store}-${digest}`;
}
