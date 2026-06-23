import { createClient } from '@supabase/supabase-js';
import { config, assertConfig } from './config.js';

assertConfig();

export const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
  auth: { persistSession: false }
});
