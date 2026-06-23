import dotenv from 'dotenv';
dotenv.config();

function boolEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
}

function numberEnv(value, defaultValue) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const config = {
  port: numberEnv(process.env.PORT, 4000),
  corsOrigin: process.env.CORS_ORIGIN || '',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  outlookUrl: process.env.OUTLOOK_URL || 'https://outlook.office.com/mail/inbox',
  outlookSearchQuery: process.env.OUTLOOK_SEARCH_QUERY || '',
  outlookScanMode: process.env.OUTLOOK_SCAN_MODE || 'inbox',
  outlookMaxEmails: numberEnv(process.env.OUTLOOK_MAX_EMAILS, 25),
  outlookHeadless: boolEnv(process.env.OUTLOOK_HEADLESS, true),
  outlookLoginHeadless: boolEnv(process.env.OUTLOOK_LOGIN_HEADLESS, !process.env.DISPLAY),
  outlookLoginWaitMs: numberEnv(process.env.OUTLOOK_LOGIN_WAIT_MS, 10 * 60 * 1000),
  outlookLoadTimeoutMs: numberEnv(process.env.OUTLOOK_LOAD_TIMEOUT_MS, 90000),
  outlookLoginGraceMs: numberEnv(process.env.OUTLOOK_LOGIN_GRACE_MS, 8000)
};

export function assertConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}
