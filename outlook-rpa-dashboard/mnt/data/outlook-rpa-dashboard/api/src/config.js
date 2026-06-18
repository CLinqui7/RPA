import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  outlookSearchQuery: process.env.OUTLOOK_SEARCH_QUERY || '(PO OR Order OR Tracking OR Approval)',
  outlookMaxEmails: Number(process.env.OUTLOOK_MAX_EMAILS || 25),
  outlookHeadless: String(process.env.OUTLOOK_HEADLESS || 'false').toLowerCase() === 'true'
};

export function assertConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) throw new Error(`Missing env vars: ${missing.join(', ')}`);
}
