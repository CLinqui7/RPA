import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { analyzeEmail, correlateEvents } from './parser.js';

function boolEnv(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
}

function nowToken() {
  return `${Date.now()}-${process.hrtime.bigint().toString(36)}`;
}

function uniqueExternalKey(base = 'email', runId = 'manual', index = 0) {
  const raw = `${base}|${runId}|${index}|${nowToken()}`;
  const shortHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${base}|scan:${runId}|row:${index}|${shortHash}`;
}

function isDuplicateError(error) {
  const message = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ');
  return /duplicate|unique|23505|external_key/i.test(message);
}

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

function toEmailEventRow(email, index, { runId = null, allowDuplicates = true } = {}) {
  const analysis = email.analysis || analyzeEmail(email);
  const originalExternalKey = email.externalKey || `${email.subject || 'no-subject'}|${email.senderEmail || 'no-sender'}|${index}`;
  const externalKey = allowDuplicates
    ? uniqueExternalKey(originalExternalKey, runId || 'no-run', index)
    : originalExternalKey;

  return {
    external_key: externalKey,
    message_type: analysis.messageType || email.messageType || 'unknown',
    status: 'new',
    subject: analysis.cleanSubject || email.subject,
    sender_name: email.senderName,
    sender_email: email.senderEmail,
    received_at: null,
    snippet: email.snippet,
    // Keep full body in DB for audit/debug, but web v19+ must not display full body.
    body_text: email.bodyText,
    po_number: analysis.poNumber || email.poNumber,
    customer_name: analysis.customerName || email.customerName,
    operator_name: analysis.operatorName || email.operatorName,
    has_attachments: email.hasAttachments || false,
    attachments: email.attachments || [],
    raw: {
      ...(email.raw || {}),
      original_external_key: originalExternalKey,
      scan_run_id: runId,
      duplicate_mode: allowDuplicates ? 'accepted_new_row_per_scan' : 'upsert_by_original_external_key',
      downloadedDocuments: email.downloadedDocuments || [],
      ptNumber: analysis.ptNumber || email.ptNumber || null,
      shipWindow: analysis.shipWindow || null,
      analysis
    }
  };
}

async function insertRowsAllowingFallback(rows, runId) {
  const { data, error } = await supabase
    .from('email_events')
    .insert(rows)
    .select('*');

  if (!error) return data || [];

  // If a very rare collision happens, retry each row with a fresh unique key.
  if (!isDuplicateError(error)) throw error;

  const inserted = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = {
      ...rows[index],
      external_key: uniqueExternalKey(rows[index].raw?.original_external_key || rows[index].external_key, runId || 'retry', index),
      raw: {
        ...(rows[index].raw || {}),
        duplicate_retry: true,
        duplicate_error: error.message
      }
    };
    const { data: one, error: oneError } = await supabase
      .from('email_events')
      .insert(row)
      .select('*')
      .single();
    if (oneError) throw oneError;
    inserted.push(one);
  }
  return inserted;
}

export async function upsertEmails(emails, options = {}) {
  if (!emails.length) return [];

  const allowDuplicates = options.allowDuplicates ?? boolEnv(process.env.ALLOW_DUPLICATE_EMAIL_EVENTS, true);
  const rows = emails.map((email, index) => toEmailEventRow(email, index, { ...options, allowDuplicates }));

  if (allowDuplicates) {
    const inserted = await insertRowsAllowingFallback(rows, options.runId);
    return correlateEvents(inserted || []);
  }

  const { data, error } = await supabase
    .from('email_events')
    .upsert(rows, { onConflict: 'external_key', ignoreDuplicates: false })
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
