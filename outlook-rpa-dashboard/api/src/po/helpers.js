export function cleanText(value = '') {
  return String(value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\r/g, '')
    .trim();
}

export function compactText(value = '') {
  return cleanText(value).replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeMoney(value) {
  if (value === undefined || value === null || value === '') return null;
  const numeric = String(value).replace(/[$,]/g, '').trim();
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(String(value).replace(/[,]/g, '').trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function normalizeDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const m = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return raw;
  const month = m[1].padStart(2, '0');
  const day = m[2].padStart(2, '0');
  let year = m[3];
  if (year.length === 2) year = Number(year) > 70 ? `19${year}` : `20${year}`;
  return `${year}-${month}-${day}`;
}

export function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

export function missingFields(object, fields) {
  return fields.filter(field => object[field] === undefined || object[field] === null || object[field] === '');
}

export function inferStatus({ headerMissing = [], lineMissing = [], conflicts = [] } = {}) {
  if (conflicts.length) return 'needs_mapping';
  if (headerMissing.length || lineMissing.length) return 'needs_mapping';
  return 'parsed';
}
