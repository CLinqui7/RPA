function clean(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// MASTER-ONLY POLICY:
// This layer performs shape cleanup only. It must not inject customer, store,
// terms, division, or warehouse codes. Those values are resolved later from
// official masters by enrichOrderWithMasters().
export function applyA2000HeaderDefaults(header = {}) {
  return {
    ...header,
    customer_code: clean(header.customer_code) || null,
    store_code: clean(header.store_code) || null,
    warehouse_code: clean(header.warehouse_code) || null,
    division_code: clean(header.division_code) || null,
    terms_code: clean(header.terms_code) || null
  };
}
