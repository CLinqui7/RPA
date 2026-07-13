import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { config } from './config.js';

function boolEnv(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'y'].includes(String(value).toLowerCase());
}

function normalizePathPart(value = '') {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown';
}

function todayFolder() {
  return new Date().toISOString().slice(0, 10);
}

function uniqueExternalKey(base = 'document', runId = 'manual', index = 0, sha256 = '') {
  const raw = `${base}|${runId}|${index}|${Date.now()}|${process.hrtime.bigint().toString(36)}|${sha256}`;
  const shortHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  return `${base}|scan:${runId}|doc:${index}|${shortHash}`;
}

function isDuplicateError(error) {
  const message = [error?.message, error?.details, error?.hint, error?.code].filter(Boolean).join(' ');
  return /duplicate|unique|23505|external_key/i.test(message);
}

async function ensureBucket(logs = []) {
  const bucket = config.invoiceStorageBucket;
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) throw listError;

  if ((buckets || []).some(item => item.name === bucket)) return bucket;

  const { error } = await supabase.storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: 50 * 1024 * 1024
  });

  // Race-safe: if another run created it first, keep going.
  if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
  logs.push(`Supabase Storage bucket ready: ${bucket}`);
  return bucket;
}

async function insertDocumentRow(row, { allowDuplicates, runId, index, sha256 }) {
  if (!allowDuplicates) {
    const { data, error } = await supabase
      .from('documents')
      .upsert(row, { onConflict: 'external_key' })
      .select('*')
      .single();
    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from('documents')
    .insert(row)
    .select('*')
    .single();

  if (!error) return data;
  if (!isDuplicateError(error)) throw error;

  // Extremely rare, but make duplicates truly accepted even if a unique key collides.
  const retryRow = {
    ...row,
    external_key: uniqueExternalKey(row.raw?.original_external_key || row.external_key, runId || 'retry', index, sha256),
    raw: {
      ...(row.raw || {}),
      duplicate_retry: true,
      duplicate_error: error.message
    }
  };

  const { data: retryData, error: retryError } = await supabase
    .from('documents')
    .insert(retryRow)
    .select('*')
    .single();
  if (retryError) throw retryError;
  return retryData;
}

// A2000_V4_6_8_1_CONTENT_SHA_STORAGE_REUSE
export async function saveDownloadedDocuments(documents = [], logs = [], options = {}) {
  if (!documents.length) return [];

  const allowDuplicates = options.allowDuplicates ?? boolEnv(process.env.ALLOW_DUPLICATE_DOCUMENTS, true);
  const runId = options.runId || `manual-${Date.now()}`;
  const bucket = await ensureBucket(logs);
  const saved = [];

  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const buffer = await fs.readFile(document.localPath);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    const fileName = normalizePathPart(document.fileName || path.basename(document.localPath));
    const originalExternalKey = document.externalKey || `${document.emailExternalKey || 'email'}|${sha256}`;

    if (!allowDuplicates) {
      const { data: existingRows, error: existingError } = await supabase
        .from('documents')
        .select('*')
        .eq('sha256', sha256)
        .limit(1);

      if (existingError) throw existingError;

      const existing = Array.isArray(existingRows) ? existingRows[0] : null;

      if (existing) {
        // Preserve one document identity per email + attachment while reusing the
        // already stored PDF bytes. This lets attachment recovery become complete
        // for the new Outlook message without duplicating Storage objects.
        const aliasRow = {
          external_key: originalExternalKey,
          source: 'outlook_rpa',
          email_external_key: document.emailExternalKey || null,
          subject: document.subject || null,
          sender_name: document.senderName || null,
          sender_email: document.senderEmail || null,
          file_name: document.fileName || fileName,
          storage_bucket: existing.storage_bucket,
          storage_path: existing.storage_path,
          file_size: existing.file_size || buffer.length,
          sha256,
          status: 'downloaded',
          raw: {
            ...(document.raw || {}),
            original_external_key: originalExternalKey,
            scan_run_id: runId,
            duplicate_mode: 'content_sha256_storage_reuse_with_email_attachment_alias',
            reused_content_document_id: existing.id,
            localPath: document.localPath,
            downloadedAt: document.downloadedAt || new Date().toISOString()
          }
        };

        const alias = await insertDocumentRow(aliasRow, {
          allowDuplicates: false,
          runId,
          index,
          sha256
        });

        saved.push(alias);
        logs.push(`PDF bytes already in Supabase Storage. Reused content and linked attachment to current email: ${document.fileName || fileName}`);
        continue;
      }
    }

    const emailKey = normalizePathPart(document.emailExternalKey || document.subject || 'email');
    const runSegment = allowDuplicates ? normalizePathPart(`run-${String(runId).slice(0, 24)}-${Date.now()}-${index}`) : '';
    const storagePath = [
      'outlook-rpa',
      todayFolder(),
      emailKey,
      runSegment,
      `${sha256.slice(0, 12)}-${fileName}`
    ].filter(Boolean).join('/');

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(storagePath, buffer, {
        contentType: 'application/pdf',
        upsert: true
      });

    if (uploadError) throw uploadError;

    const row = {
      external_key: allowDuplicates ? uniqueExternalKey(originalExternalKey, runId, index, sha256) : originalExternalKey,
      source: 'outlook_rpa',
      email_external_key: document.emailExternalKey || null,
      subject: document.subject || null,
      sender_name: document.senderName || null,
      sender_email: document.senderEmail || null,
      file_name: document.fileName || fileName,
      storage_bucket: bucket,
      storage_path: storagePath,
      file_size: buffer.length,
      sha256,
      status: 'downloaded',
      raw: {
        ...(document.raw || {}),
        original_external_key: originalExternalKey,
        scan_run_id: runId,
        duplicate_mode: allowDuplicates ? 'accepted_new_row_per_scan' : 'content_sha256_storage_reuse_then_upsert_external_key',
        localPath: document.localPath,
        downloadedAt: document.downloadedAt || new Date().toISOString()
      }
    };

    const data = await insertDocumentRow(row, { allowDuplicates, runId, index, sha256 });
    saved.push(data);
    logs.push(`PDF saved in Supabase: ${bucket}/${storagePath}`);
  }

  return saved;
}


export async function downloadedDocumentFileNamesForEmail(emailExternalKey) {
  if (!emailExternalKey) return [];

  const { data, error } = await supabase
    .from('documents')
    .select('file_name')
    .eq('email_external_key', emailExternalKey)
    .limit(500);

  if (error) throw error;

  return [
    ...new Set(
      (data || [])
        .map(row => row.file_name)
        .filter(Boolean)
    )
  ];
}

export async function listDocuments({ limit = 200 } = {}) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// Compatibility export for outlookScanner.js.
// When duplicate mode is enabled, return false so the scanner reads/downloads the email again.
// When duplicate mode is disabled, query Supabase to avoid re-downloading documents for the same email.
export async function hasDownloadedDocumentsForEmail(emailExternalKey, options = {}) {
  const allowDuplicates = options.allowDuplicates ?? boolEnv(process.env.ALLOW_DUPLICATE_DOCUMENTS, true);
  if (allowDuplicates) return false;
  if (!emailExternalKey) return false;

  const { data, error } = await supabase
    .from('documents')
    .select('id, external_key, email_external_key, file_name, created_at')
    .eq('email_external_key', emailExternalKey)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}
