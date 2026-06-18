import { supabase } from './supabase.js';

export async function createRun() {
  const { data, error } = await supabase.from('rpa_runs').insert({ status: 'running' }).select('*').single();
  if (error) throw error;
  return data;
}

export async function finishRun(id, patch) {
  const { data, error } = await supabase
    .from('rpa_runs')
    .update({ ...patch, finished_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function upsertEmails(emails) {
  if (!emails.length) return [];
  const rows = emails.map(e => ({
    external_key: e.externalKey,
    message_type: e.messageType || 'unknown',
    status: 'new',
    subject: e.subject,
    sender_name: e.senderName,
    sender_email: e.senderEmail,
    received_at: e.receivedAt,
    snippet: e.snippet,
    body_text: e.bodyText,
    po_number: e.poNumber,
    has_attachments: e.hasAttachments || false,
    attachments: [],
    raw: e.raw || {}
  }));

  const { data, error } = await supabase
    .from('email_events')
    .upsert(rows, { onConflict: 'external_key', ignoreDuplicates: true })
    .select('*');
  if (error) throw error;
  return data || [];
}

export async function listEvents() {
  const { data, error } = await supabase
    .from('email_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data || [];
}

export async function markEvent(id, status) {
  const { data, error } = await supabase
    .from('email_events')
    .update({ status })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return data;
}
