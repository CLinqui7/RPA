import { supabase } from './supabase.js';
import { analyzeEmail, correlateEvents } from './parser.js';

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

  const rows = emails.map(email => {
    const analysis = email.analysis || analyzeEmail(email);
    return {
      external_key: email.externalKey,
      message_type: analysis.messageType || email.messageType || 'unknown',
      status: 'new',
      subject: analysis.cleanSubject || email.subject,
      sender_name: email.senderName,
      sender_email: email.senderEmail,
      received_at: null,
      snippet: email.snippet,
      body_text: email.bodyText,
      po_number: analysis.poNumber || email.poNumber,
      customer_name: analysis.customerName || email.customerName,
      operator_name: analysis.operatorName || email.operatorName,
      has_attachments: email.hasAttachments || false,
      attachments: email.attachments || [],
      raw: {
        ...(email.raw || {}),
        ptNumber: analysis.ptNumber || email.ptNumber || null,
        shipWindow: analysis.shipWindow || null,
        analysis
      }
    };
  });

  const { data, error } = await supabase
    .from('email_events')
    .upsert(rows, { onConflict: 'external_key', ignoreDuplicates: true })
    .select('*');
  if (error) throw error;
  return correlateEvents(data || []);
}

export async function listEvents({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('email_events')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return correlateEvents(data || []);
}

export async function markEvent(id, status) {
  const { data, error } = await supabase
    .from('email_events')
    .update({ status })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;
  return correlateEvents(data ? [data] : [])[0] || data;
}
