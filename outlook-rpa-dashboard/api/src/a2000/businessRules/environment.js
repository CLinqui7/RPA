export function resolveA2000Environment(env = process.env) {
  const explicit = String(env.A2000_ENVIRONMENT || '').trim();
  if (explicit) return explicit.toUpperCase();

  const baseUrl = String(env.A2000_BASE_URL || '').toLowerCase();
  if (baseUrl.includes('amextest') || baseUrl.includes('/amxtest')) {
    return 'AMEXTEST';
  }
  if (baseUrl.includes('/prod') || baseUrl.includes('production')) {
    return 'PRODUCTION';
  }
  return 'UNKNOWN';
}
