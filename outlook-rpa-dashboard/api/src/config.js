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

// RPA_CODESPACES_HEADLESS_GUARD_V1
export function resolveOutlookHeadless({
  requested = process.env.OUTLOOK_HEADLESS,
  display = process.env.DISPLAY,
  waylandDisplay = process.env.WAYLAND_DISPLAY
} = {}) {
  const graphicalDisplayAvailable = Boolean(
    String(display || '').trim()
    || String(waylandDisplay || '').trim()
  );

  // A headed Chromium process cannot start without X11/Wayland.
  // Respect OUTLOOK_HEADLESS=false only when a display actually exists.
  return boolEnv(requested, true) || !graphicalDisplayAvailable;
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
  outlookHeadless: resolveOutlookHeadless(),
  outlookLoginHeadless: boolEnv(process.env.OUTLOOK_LOGIN_HEADLESS, !process.env.DISPLAY),
  outlookLoginWaitMs: numberEnv(process.env.OUTLOOK_LOGIN_WAIT_MS, 10 * 60 * 1000),
  outlookLoadTimeoutMs: numberEnv(process.env.OUTLOOK_LOAD_TIMEOUT_MS, 90000),
  outlookLoginGraceMs: numberEnv(process.env.OUTLOOK_LOGIN_GRACE_MS, 8000),

  // MVP A2000 invoice intake:
  // First milestone only downloads PDFs from Outlook when the subject matches this filter.
  invoiceSubjectFilter: process.env.INVOICE_SUBJECT_FILTER || 'factura american',
  invoiceDownloadOnlyMatching: boolEnv(process.env.INVOICE_DOWNLOAD_ONLY_MATCHING, true),
  invoiceReceivedOnly: boolEnv(process.env.INVOICE_RECEIVED_ONLY, true),
  invoiceRequireUnread: boolEnv(process.env.INVOICE_REQUIRE_UNREAD, true),
  invoiceMarkAsRead: boolEnv(process.env.INVOICE_MARK_AS_READ, true),
  invoiceSkipAlreadyDownloaded: boolEnv(process.env.INVOICE_SKIP_ALREADY_DOWNLOADED, true),
  invoiceStorageBucket: process.env.INVOICE_STORAGE_BUCKET || 'po-documents',
  invoiceLocalDownloadDir: process.env.INVOICE_LOCAL_DOWNLOAD_DIR || 'downloads/invoices'
};

export function assertConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}
