import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { supabase } from './supabase.js';
import { config } from './config.js';

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

function cleanFileName(name = 'document.pdf') {
  const normalized = normalizePathPart(name);
  return /\.pdf$/i.test(normalized) ? normalized : `${normalized}.pdf`;
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

  if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
  logs.push(`Supabase Storage bucket ready: ${bucket}`);
  return bucket;
}

async function findExistingBySha(sha256) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('sha256', sha256)
    .order('created_at', { ascending: true })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

async function savePdfBuffer({ buffer, fileName, source, subject = null, senderName = null, senderEmail = null, emailExternalKey = null, raw = {}, logs = [] }) {
  const bucket = await ensureBucket(logs);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await findExistingBySha(sha256);
  if (existing) {
    logs.push(`PDF already exists in Supabase by sha256, skipping duplicate document row: ${existing.file_name}`);
    return { ...existing, duplicate: true };
  }

  const safeFileName = cleanFileName(fileName || 'document.pdf');
  const sourceFolder = normalizePathPart(source || 'manual_upload');
  const storagePath = [
    sourceFolder,
    todayFolder(),
    `${sha256.slice(0, 12)}-${safeFileName}`
  ].join('/');

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (uploadError) throw uploadError;

  const row = {
    external_key: `${source || 'document'}|pdf|${sha256}`,
    source: source || 'manual_upload',
    email_external_key: emailExternalKey,
    subject,
    sender_name: senderName,
    sender_email: senderEmail,
    file_name: fileName || safeFileName,
    storage_bucket: bucket,
    storage_path: storagePath,
    file_size: buffer.length,
    sha256,
    status: 'downloaded',
    raw: {
      ...(raw || {}),
      uploadedAt: new Date().toISOString()
    }
  };

  const { data, error } = await supabase
    .from('documents')
    .upsert(row, { onConflict: 'external_key' })
    .select('*')
    .single();

  if (error) throw error;
  logs.push(`PDF saved in Supabase: ${bucket}/${storagePath}`);
  return data;
}


export async function hasDownloadedDocumentsForEmail(emailExternalKey) {
  if (!emailExternalKey) return false;

  const { data, error } = await supabase
    .from('documents')
    .select('id')
    .eq('email_external_key', emailExternalKey)
    .limit(1);

  if (error) throw error;
  return (data || []).length > 0;
}

export async function getDownloadedDocumentsForEmail(emailExternalKey) {
  if (!emailExternalKey) return [];

  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('email_external_key', emailExternalKey)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data || [];
}

export async function saveUploadedDocument(file, logs = []) {
  if (!file?.buffer) throw new Error('No PDF file received');
  if (!/\.pdf$/i.test(file.originalname || '')) throw new Error('Only PDF files are accepted');

  return savePdfBuffer({
    buffer: file.buffer,
    fileName: file.originalname,
    source: 'manual_upload',
    subject: 'manual upload',
    raw: {
      originalName: file.originalname,
      mimetype: file.mimetype,
      size: file.size
    },
    logs
  });
}

export async function saveDownloadedDocuments(documents = [], logs = []) {
  if (!documents.length) return [];

  const saved = [];
  for (const document of documents) {
    const buffer = await fs.readFile(document.localPath);
    const result = await savePdfBuffer({
      buffer,
      fileName: document.fileName || path.basename(document.localPath),
      source: 'outlook_rpa',
      subject: document.subject || null,
      senderName: document.senderName || null,
      senderEmail: document.senderEmail || null,
      emailExternalKey: document.emailExternalKey || null,
      raw: {
        ...(document.raw || {}),
        localPath: document.localPath,
        currentUrl: document.currentUrl,
        downloadedAt: document.downloadedAt || new Date().toISOString(),
        fallbackName: document.fallbackName,
        suggestedName: document.suggestedName
      },
      logs
    });
    saved.push(result);
  }

  return saved;
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

export async function getDocumentById(id) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

export async function downloadDocumentBuffer(id) {
  const document = await getDocumentById(id);
  if (!document?.storage_bucket || !document?.storage_path) {
    throw new Error('Document has no storage path');
  }

  const { data, error } = await supabase.storage
    .from(document.storage_bucket)
    .download(document.storage_path);

  if (error) throw error;
  const arrayBuffer = await data.arrayBuffer();
  return {
    document,
    buffer: Buffer.from(arrayBuffer)
  };
}
