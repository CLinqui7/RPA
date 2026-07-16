import { createOperationalExtensionsRouter, startOperationalExtensions } from './a2000/operationalExtensions.js';
import { config } from './config.js';
import {
  runScan,
  runScanDependencyStatus
} from './runScan.js';
import { listEvents, markEvent } from './runRepository.js';
import { listDocuments, saveDownloadedDocuments } from './documentRepository.js';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';
import { supabase } from './supabase.js';
import {
  launchStatus,
  listOperationalOrders,
  listOperationsLog,
  processDocumentWorkflow,
  processPendingDocuments,
  uploadAllValidatedOrders,
  uploadOrderWorkflow,
  preflightOrderWorkflow,
  preflightOperationalOrders
} from './po/productionWorkflow.js';
import { checklistCatalog, checklistDownloadPath, generateChecklistForOrder, rebuildChecklistCatalog } from './checklists/checklistService.js';
import { rowsToCsv, A2000_HEADER_COLUMNS, A2000_LINE_COLUMNS } from './a2000/csv.js';
import { officialMasterReferenceUpc } from './a2000/restMapper.js';
import { applyExplicitA2000QtyBuckets, hasBlockingA2000Conflicts, isStrictA2000Header, isStrictA2000Line, strictHeaderMissing, strictLineMissing } from './a2000/strictImport.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import cors from 'cors';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

const app = express();
const DEFAULT_INVOICE_SUBJECT_FILTER = process.env.INVOICE_SUBJECT_FILTER || config.invoiceSubjectFilter || 'factura american';

const corsOptions = {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

app.use('/po', createOperationalExtensionsRouter());
const EXPORTS_DIR = path.join(API_ROOT, 'exports');
app.use('/exports', express.static(EXPORTS_DIR));

function normalizeForFilter(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function subjectMatchesFilter(event = {}, filter = DEFAULT_INVOICE_SUBJECT_FILTER) {
  const normalizedFilter = normalizeForFilter(filter);
  if (!normalizedFilter) return true;

  const alternatives = normalizedFilter.split('|').map(part => part.trim()).filter(Boolean);
  const analysis = event.raw?.analysis || event.analysis || {};
  const subjectHaystack = normalizeForFilter([
    event.subject,
    analysis.cleanSubject,
    analysis.displayTitle
  ].filter(Boolean).join(' '));

  return alternatives.some(item => subjectHaystack.includes(item));
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'outlook-rpa-api',
    port: config.port,
    outlookHeadless: config.outlookHeadless,
    invoiceSubjectFilter: DEFAULT_INVOICE_SUBJECT_FILTER
  });
});

function candidateTestPdfDirs() {
  const candidates = [];
  if (process.env.A2000_TEST_PDF_DIR) candidates.push(path.resolve(process.env.A2000_TEST_PDF_DIR));

  // The API may be launched from repo root, /api, or by npm --prefix.
  // Use file location as the anchor so the web lab never searches only /api/test-pdfs.
  candidates.push(path.resolve(PROJECT_ROOT, 'test-pdfs'));
  candidates.push(path.resolve(API_ROOT, 'test-pdfs'));
  candidates.push(path.resolve(process.cwd(), 'test-pdfs'));
  candidates.push(path.resolve(process.cwd(), '..', 'test-pdfs'));
  candidates.push(path.resolve(process.cwd(), '..', '..', 'test-pdfs'));

  return [...new Set(candidates)];
}

async function getExistingTestPdfDir() {
  const candidates = candidateTestPdfDirs();
  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch {
      // Try next candidate.
    }
  }

  const error = new Error(`No se encontró carpeta test-pdfs. Buscado en: ${candidates.join(', ')}`);
  error.searchedDirs = candidates;
  throw error;
}

async function listTestPdfFiles() {
  const dir = await getExistingTestPdfDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile() && /\.pdf$/i.test(entry.name))
    .map(entry => path.join(dir, entry.name))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return { dir, files };
}

function compactLine(line = {}) {
  const qtyBuckets = Object.fromEntries(
    Array.from({ length: 18 }, (_, index) => {
      const bucket = index + 1;
      return [`qty_sz${bucket}`, line[`qty_sz${bucket}`] ?? null];
    })
  );

  return {
    line_no: line.line_no,
    customer_sku: line.customer_sku || null,
    ticket_sku: line.ticket_sku || null,
    customer_upc: line.customer_upc || null,
    master_upc: line.master_upc || null,
    master_upcs_by_size: line.master_upcs_by_size || [],
    internal_sku: line.internal_sku || line.master_sku || null,
    style_raw: line.style_raw || null,
    style_code: line.style_code || null,
    color_raw: line.color_raw || null,
    color_code: line.color_code || null,
    description: line.description || null,
    list_price: line.list_price ?? null,
    sales_price: line.sales_price ?? null,
    master_price: line.master_price ?? null,
    qty_total: line.qty_total ?? null,
    ...qtyBuckets,
    warehouse_code: line.warehouse_code || null,
    size_raw: line.size_raw || null,
    size_code: line.size_code || null,
    a2000_size_no: line.a2000_size_no || null,
    cust_style1: line.cust_style1 || null,
    cust_style2: line.cust_style2 || null,
    reference: line.reference || null,
    scale_code: line.scale_code || null,
    scale_abbr: line.scale_abbr || null,
    missing_fields: line.missing_fields || [],
    raw: line.raw || {},
    master_candidates: {
      style: line.raw?.style_master_candidates || [],
      color: line.raw?.color_master_candidates || [],
      upc: line.raw?.upc_master_candidates || []
    }
  };
}


function compactParsed(file, parsed, elapsedMs = null) {
  return {
    file,
    file_name: path.basename(file),
    parser: parsed.parser,
    status: parsed.status,
    confidence: parsed.confidence ?? null,
    elapsed_ms: elapsedMs,
    header: parsed.header || {},
    totals: parsed.totals || {},
    missing: parsed.needs_mapping || { header: [], lines: [], conflicts: [] },
    conflicts: parsed.conflicts || [],
    master_lookup: parsed.raw_enrichment?.master_lookup || null,
    line_count: parsed.lines?.length || 0,
    lines: (parsed.lines || []).map(compactLine),
    parsed_raw: parsed
  };
}


function cleanExportValue(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function trimExport(value, max = 20) {
  return cleanExportValue(value).slice(0, max);
}

function formatA2000Date(value) {
  const raw = cleanExportValue(value);
  if (!raw) return '';
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(raw)) return raw;
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const [yyyy, mm, dd] = raw.slice(0, 10).split('-');
    return `${Number(mm)}/${Number(dd)}/${yyyy}`;
  }
  return raw;
}

function blankExportRow(columns) {
  return Object.fromEntries(columns.map(column => [column, '']));
}

function a2000HeaderRowFromParsed(item) {
  const h = item.header || {};
  const row = blankExportRow(A2000_HEADER_COLUMNS);
  row.CUST_NO = cleanExportValue(h.customer_code);
  row.STORE_NO = cleanExportValue(h.store_code);
  row.ORDER_NO = cleanExportValue(h.order_no);
  row.ORDER_DATE = formatA2000Date(h.order_date);
  row.START_DATE = formatA2000Date(h.start_date);
  row.CANCEL_DATE = formatA2000Date(h.cancel_date);
  row.BOOK_DATE = formatA2000Date(h.book_date);
  row.CUST_DEPT = cleanExportValue(h.dept_code);
  row.DIV_NO = cleanExportValue(h.division_code);
  row.SHIP_VIA_NO = cleanExportValue(h.ship_via_code);
  row.TERM_NO = cleanExportValue(h.terms_code);
  row.USER_REF1 = trimExport(h.order_no || item.file_name, 20);
  row.USER_REF2 = trimExport(item.subject || h.terms_raw || '', 20);
  row.USER_REF3 = trimExport(item.status, 20);
  row.MASTER_INVOICE = cleanExportValue(h.master_invoice);
  row.DEF_WHOUSE = cleanExportValue(h.warehouse_code);
  return row;
}

function a2000LineRowFromParsed(item, line) {
  const h = item.header || {};
  const row = blankExportRow(A2000_LINE_COLUMNS);
  row.LINE_NO = cleanExportValue(line.line_no);
  row.CUST_NO = cleanExportValue(h.customer_code);
  row._NO = cleanExportValue(h.store_code);
  row.ORDER_NO = cleanExportValue(h.order_no);
  row.STYLE = cleanExportValue(line.style_code);
  row.COLOR_NO = cleanExportValue(line.color_code);
  row.SALES_PRICE = cleanExportValue(line.sales_price);
  row.WHOUSE = cleanExportValue(line.warehouse_code || h.warehouse_code);
  applyExplicitA2000QtyBuckets(row, line);
  // Optional A2000 fields must be explicitly resolved for their exact target
  // semantics. Do not repurpose raw customer SKU/UPC/size text as SIZE_NO,
  // CUST_STYLE1, CUST_STYLE2 or REF.
  row.SIZE_NO = cleanExportValue(line.a2000_size_no);
  row.CUST_STYLE1 = trimExport(line.cust_style1, 6);
  row.CUST_STYLE2 = trimExport(line.cust_style2, 20);
  row.REF = trimExport(
    officialMasterReferenceUpc(line) || line.reference,
    15
  );
  row.LIST_PRICE = cleanExportValue(line.list_price);
  return row;
}

function buildA2000ExportRows(results = []) {
  const importable = (results || []).filter(item => {
    const header = item.header || {};
    const lines = item.lines || [];
    return item.status === 'parsed'
      && !hasBlockingA2000Conflicts(item)
      && isStrictA2000Header(header)
      && lines.some(line => isStrictA2000Line(header, line));
  });
  const headerRows = importable.map(a2000HeaderRowFromParsed);
  const lineRows = [];
  for (const item of importable) {
    const header = item.header || {};
    for (const line of item.lines || []) {
      if (!isStrictA2000Line(header, line)) continue;
      lineRows.push(a2000LineRowFromParsed(item, line));
    }
  }
  return { importable, headerRows, lineRows };
}

function exportUrlFor(filePath) {
  return `/exports/${path.basename(filePath)}`;
}

async function ensureExportsDirLocal() {
  await fs.mkdir(EXPORTS_DIR, { recursive: true });
  return EXPORTS_DIR;
}

async function parseDocumentsForExport(req, source) {
  if (source === 'test') {
    const requested = Array.isArray(req.body?.files) ? req.body.files : null;
    const discovered = requested?.length ? null : await listTestPdfFiles();
    const files = requested?.length
      ? requested.map(file => path.isAbsolute(file) ? file : path.resolve(PROJECT_ROOT, file))
      : discovered.files;
    const results = [];
    for (const file of files) {
      const started = Date.now();
      try {
        const buffer = await fs.readFile(file);
        const text = await extractPdfTextFromBuffer(buffer);
        const parsedOrders = parsePurchaseOrders({ text, fileName: path.basename(file), document: { file_name: path.basename(file), file_path: file }});
        parsedOrders.forEach((parsed, orderIndex) => {
          results.push({
            ...compactParsed(file, parsed, Date.now() - started),
            source_document_order_index: parsed.header?.raw?.source_order_index || orderIndex + 1,
            source_document_order_count: parsed.header?.raw?.source_order_count || parsedOrders.length
          });
        });
      } catch (error) {
        results.push({ file, file_name: path.basename(file), status: 'error', error: error.message, elapsed_ms: Date.now() - started });
      }
    }
    return results;
  }

  const requestedIds = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
  const documents = (await listInvoiceDocuments(req)).filter(doc => !requestedIds || requestedIds.has(String(doc.id)));
  const results = [];
  for (const doc of documents) {
    const started = Date.now();
    try {
      const loaded = await readBufferForStoredDocument(doc);
      const text = await extractPdfTextFromBuffer(loaded.buffer);
      const parsedOrders = parsePurchaseOrders({
        text,
        fileName: doc.file_name,
        document: { id: doc.id, file_name: doc.file_name, file_path: loaded.path, storage_bucket: doc.storage_bucket, storage_path: doc.storage_path, subject: doc.subject, sender_email: doc.sender_email, source: doc.source }
      });
      parsedOrders.forEach((parsed, orderIndex) => {
        results.push({
          ...compactParsed(loaded.path, parsed, Date.now() - started),
          source: 'email_document',
          document_id: doc.id,
          subject: doc.subject,
          sender_name: doc.sender_name,
          sender_email: doc.sender_email,
          created_at: doc.created_at,
          storage_bucket: doc.storage_bucket,
          storage_path: doc.storage_path,
          local_path: doc.raw?.localPath || null,
          file_load_source: loaded.source,
          source_document_order_index: parsed.header?.raw?.source_order_index || orderIndex + 1,
          source_document_order_count: parsed.header?.raw?.source_order_count || parsedOrders.length
        });
      });
    } catch (error) {
      results.push({ source: 'email_document', document_id: doc.id, file_name: doc.file_name, subject: doc.subject, sender_email: doc.sender_email, status: 'error', error: error.message, elapsed_ms: Date.now() - started });
    }
  }
  return results;
}

async function safeReadPdfFromQuery(req) {
  const documentId = String(req.query.document_id || '').trim();
  if (documentId) {
    const docs = await listDocuments({ limit: 500 });
    const doc = docs.find(item => String(item.id) === documentId);
    if (!doc) throw new Error('Documento no encontrado en Supabase/documents');
    const loaded = await readBufferForStoredDocument(doc);
    return { ...loaded, fileName: doc.file_name || 'factura.pdf' };
  }

  const rawFile = String(req.query.file || '').trim();
  if (!rawFile) throw new Error('Falta document_id o file');
  const resolved = path.isAbsolute(rawFile) ? rawFile : path.resolve(PROJECT_ROOT, rawFile);
  const allowedRoots = [PROJECT_ROOT, API_ROOT].map(root => path.resolve(root));
  if (!allowedRoots.some(root => resolved.startsWith(root))) throw new Error('Ruta de PDF no permitida');
  return { buffer: await fs.readFile(resolved), source: 'local_file', path: resolved, fileName: path.basename(resolved) };
}

app.get('/po/pdf-preview', async (req, res) => {
  try {
    const loaded = await safeReadPdfFromQuery(req);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${String(loaded.fileName || 'factura.pdf').replaceAll('"', '')}"`);
    res.send(loaded.buffer);
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/po/export-a2000-import', async (req, res) => {
  try {
    const source = String(req.query.source || req.body?.source || 'email') === 'test' ? 'test' : 'email';
    const results = await parseDocumentsForExport(req, source);
    const { importable, headerRows, lineRows } = buildA2000ExportRows(results);
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const exportDir = await ensureExportsDirLocal();
    const headerFileName = `A2000_IMPORT_HEADERS_${source}_${timestamp}.csv`;
    const linesFileName = `A2000_IMPORT_SALES_LINES_${source}_${timestamp}.csv`;
    const headerPath = path.join(exportDir, headerFileName);
    const linesPath = path.join(exportDir, linesFileName);
    await fs.writeFile(headerPath, rowsToCsv(A2000_HEADER_COLUMNS, headerRows), 'utf8');
    await fs.writeFile(linesPath, rowsToCsv(A2000_LINE_COLUMNS, lineRows), 'utf8');
    res.json({
      ok: true,
      source,
      generated_at: new Date().toISOString(),
      parsed_count: results.length,
      importable_count: importable.length,
      header_rows_count: headerRows.length,
      line_rows_count: lineRows.length,
      skipped_count: results.length - importable.length,
      header_file_name: headerFileName,
      lines_file_name: linesFileName,
      header_url: exportUrlFor(headerPath),
      lines_url: exportUrlFor(linesPath),
      columns: { headers: A2000_HEADER_COLUMNS, lines: A2000_LINE_COLUMNS },
      preview: { headers: headerRows.slice(0, 5), lines: lineRows.slice(0, 10) },
      skipped: results.filter(item => !importable.includes(item)).map(item => ({
        file_name: item.file_name,
        status: item.status,
        missing: item.missing,
        strict_header_missing: strictHeaderMissing(item.header || {}),
        strict_line_missing: (item.lines || []).map(line => ({ line_no: line.line_no, missing: strictLineMissing(item.header || {}, line) })).filter(entry => entry.missing.length),
        error: item.error || null
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});


app.get('/po/test-pdfs', async (_req, res) => {
  try {
    const { dir, files } = await listTestPdfFiles();
    res.json({
      ok: true,
      dir,
      searched_dirs: candidateTestPdfDirs(),
      count: files.length,
      files: files.map(file => ({ file, file_name: path.basename(file) }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, searched_dirs: error.searchedDirs || candidateTestPdfDirs(), error: error.message });
  }
});

app.post('/po/parse-test-pdfs', async (req, res) => {
  try {
    const requested = Array.isArray(req.body?.files) ? req.body.files : null;
    const discovered = requested?.length ? null : await listTestPdfFiles();
    const files = requested?.length
      ? requested.map(file => path.isAbsolute(file) ? file : path.resolve(PROJECT_ROOT, file))
      : discovered.files;

    const results = [];
    for (const file of files) {
      const started = Date.now();
      try {
        const buffer = await fs.readFile(file);
        const text = await extractPdfTextFromBuffer(buffer);
        const parsedOrders = parsePurchaseOrders({
          text,
          fileName: path.basename(file),
          document: { file_name: path.basename(file), file_path: file }
        });
        parsedOrders.forEach((parsed, orderIndex) => {
          results.push({
            ...compactParsed(file, parsed, Date.now() - started),
            source_document_order_index: parsed.header?.raw?.source_order_index || orderIndex + 1,
            source_document_order_count: parsed.header?.raw?.source_order_count || parsedOrders.length
          });
        });
      } catch (error) {
        results.push({ file, file_name: path.basename(file), status: 'error', error: error.message, elapsed_ms: Date.now() - started });
      }
    }

    res.json({
      ok: true,
      dir: discovered?.dir || null,
      searched_dirs: candidateTestPdfDirs(),
      count: results.length,
      generated_at: new Date().toISOString(),
      results
    });
  } catch (error) {
    res.status(500).json({ ok: false, searched_dirs: error.searchedDirs || candidateTestPdfDirs(), error: error.message });
  }
});


function documentLooksInScope(doc = {}, filter = DEFAULT_INVOICE_SUBJECT_FILTER) {
  const normalizedFilter = normalizeForFilter(filter);
  if (!normalizedFilter) return true;
  const alternatives = normalizedFilter.split('|').map(part => part.trim()).filter(Boolean);
  const haystack = normalizeForFilter([
    doc.subject,
    doc.file_name,
    doc.sender_name,
    doc.sender_email,
    doc.raw?.filter,
    doc.raw?.fallbackName,
    doc.raw?.suggestedName,
    doc.raw?.original_external_key
  ].filter(Boolean).join(' '));
  return alternatives.some(item => haystack.includes(item));
}

async function listInvoiceDocuments(req) {
  const showAll = String(req.query?.all || '') === '1';
  const subjectFilter = String(req.query?.subject || DEFAULT_INVOICE_SUBJECT_FILTER);
  const limit = Number(req.query?.limit || 200);
  const docs = await listDocuments({ limit });
  const scoped = showAll ? docs : docs.filter(doc => documentLooksInScope(doc, subjectFilter));
  return scoped.map(doc => ({
    ...doc,
    dashboard_scope: showAll ? 'all_documents' : 'invoice_subject_filter',
    dashboard_subject_filter: subjectFilter,
    local_path: doc.raw?.localPath || null
  }));
}

async function readBufferForStoredDocument(doc) {
  const localPath = doc.raw?.localPath || doc.local_path || null;
  if (localPath) {
    try {
      return { buffer: await fs.readFile(localPath), source: 'local_download', path: localPath };
    } catch {
      // Fall back to Supabase Storage below.
    }
  }

  if (doc.storage_bucket && doc.storage_path) {
    const { data, error } = await supabase.storage.from(doc.storage_bucket).download(doc.storage_path);
    if (error) throw error;
    const arrayBuffer = await data.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), source: 'supabase_storage', path: `${doc.storage_bucket}/${doc.storage_path}` };
  }

  throw new Error(`No se encontró archivo local ni storage_path para ${doc.file_name || doc.id}`);
}

app.get('/po/email-documents', async (req, res) => {
  try {
    const documents = await listInvoiceDocuments(req);
    res.json({
      ok: true,
      subject_filter: String(req.query?.subject || DEFAULT_INVOICE_SUBJECT_FILTER),
      count: documents.length,
      documents
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/po/parse-email-documents', async (req, res) => {
  try {
    const requestedIds = Array.isArray(req.body?.ids) ? new Set(req.body.ids.map(String)) : null;
    const documents = (await listInvoiceDocuments(req)).filter(doc => !requestedIds || requestedIds.has(String(doc.id)));
    const results = [];

    for (const doc of documents) {
      const started = Date.now();
      try {
        const loaded = await readBufferForStoredDocument(doc);
        const text = await extractPdfTextFromBuffer(loaded.buffer);
        const parsedOrders = parsePurchaseOrders({
          text,
          fileName: doc.file_name,
          document: {
            id: doc.id,
            file_name: doc.file_name,
            file_path: loaded.path,
            storage_bucket: doc.storage_bucket,
            storage_path: doc.storage_path,
            subject: doc.subject,
            sender_email: doc.sender_email,
            source: doc.source
          }
        });
        parsedOrders.forEach((parsed, orderIndex) => {
          results.push({
            ...compactParsed(loaded.path, parsed, Date.now() - started),
            source: 'email_document',
            document_id: doc.id,
            subject: doc.subject,
            sender_name: doc.sender_name,
            sender_email: doc.sender_email,
            created_at: doc.created_at,
            storage_bucket: doc.storage_bucket,
            storage_path: doc.storage_path,
            local_path: doc.raw?.localPath || null,
            file_load_source: loaded.source,
            source_document_order_index: parsed.header?.raw?.source_order_index || orderIndex + 1,
            source_document_order_count: parsed.header?.raw?.source_order_count || parsedOrders.length
          });
        });
      } catch (error) {
        results.push({
          source: 'email_document',
          document_id: doc.id,
          file: doc.raw?.localPath || doc.storage_path || doc.file_name,
          file_name: doc.file_name,
          subject: doc.subject,
          sender_email: doc.sender_email,
          status: 'error',
          error: error.message,
          elapsed_ms: Date.now() - started
        });
      }
    }

    res.json({
      ok: true,
      subject_filter: String(req.query?.subject || DEFAULT_INVOICE_SUBJECT_FILTER),
      count: results.length,
      generated_at: new Date().toISOString(),
      results
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// A2000_V4_6_STAGE1_SERVER

const manualPdfUpload = express.raw({
  type: ['application/pdf', 'application/octet-stream'],
  limit: '50mb'
});

function safeUploadFileName(value = 'manual.pdf') {
  const cleanName = path.basename(String(value || 'manual.pdf'))
    .replace(/[^a-zA-Z0-9._ -]+/g, '-')
    .trim();
  return cleanName || 'manual.pdf';
}

app.get('/po/launch-status', (_req, res) => {
  res.json({
    ok: true,
    ...launchStatus()
  });
});

app.get('/po/operational-orders', async (req, res) => {
  try {
    const orders = await listOperationalOrders({
      limit: Number(req.query.limit || 500),
      q: String(req.query.q || ''),
      customer: String(req.query.customer || ''),
      status: String(req.query.status || '')
    });

    res.json({
      ok: true,
      count: orders.length,
      orders
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get('/po/logs', async (req, res) => {
  try {
    const logs = await listOperationsLog({
      limit: Number(req.query.limit || 500),
      q: String(req.query.q || '')
    });

    res.json({
      ok: true,
      count: logs.length,
      logs
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/po/upload-pdf', manualPdfUpload, async (req, res) => {
  try {
    const fileName = safeUploadFileName(
      req.headers['x-file-name'] || 'manual.pdf'
    );

    if (!/\.pdf$/i.test(fileName)) {
      return res.status(400).json({
        ok: false,
        error: 'Solo se permiten archivos PDF.'
      });
    }

    const buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(req.body || []);

    if (!buffer.length) {
      return res.status(400).json({
        ok: false,
        error: 'El PDF está vacío.'
      });
    }

    const sha256 = crypto
      .createHash('sha256')
      .update(buffer)
      .digest('hex');

    const uploadDir = path.join(
      API_ROOT,
      'downloads',
      'manual'
    );

    await fs.mkdir(uploadDir, { recursive: true });

    const localPath = path.join(
      uploadDir,
      `${sha256.slice(0, 12)}-${fileName}`
    );

    await fs.writeFile(localPath, buffer);

    const logs = [];

    const saved = await saveDownloadedDocuments(
      [{
        localPath,
        fileName,
        externalKey: `manual|${sha256}`,
        emailExternalKey: `manual|${sha256}`,
        subject: String(
          req.headers['x-email-subject']
          || 'Manual upload - Factura American'
        ),
        senderName: 'Manual upload',
        senderEmail: null,
        downloadedAt: new Date().toISOString(),
        source: 'manual_upload',
        raw: {
          manual_upload: true,
          original_file_name: fileName,
          sha256
        }
      }],
      logs,
      {
        runId: `manual-${sha256.slice(0, 12)}`,
        allowDuplicates: false
      }
    );

    const document = saved[0];

    const workflow = await processDocumentWorkflow(
      document.id,
      {
        uploadToA2000: false,
        confirmOrderLiCleared: false
      }
    );

    res.json({
      ok: true,
      document,
      workflow,
      logs
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/po/process-document/:id', async (req, res) => {
  try {
    const workflow = await processDocumentWorkflow(
      req.params.id,
      {
        uploadToA2000: req.body?.upload_to_a2000 === true,
        confirmOrderLiCleared: (
          req.body?.confirm_order_li_cleared === true
        )
      }
    );

    res.json({
      ok: true,
      workflow
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/po/process-pending', async (req, res) => {
  try {
    const workflow = await processPendingDocuments({
      limit: Number(req.body?.limit || 50),
      uploadToA2000: req.body?.upload_to_a2000 === true,
      confirmOrderLiCleared: (
        req.body?.confirm_order_li_cleared === true
      )
    });

    res.json({
      ok: true,
      workflow
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/po/orders/:id/a2000', async (req, res) => {
  try {
    const workflow = await uploadOrderWorkflow(
      req.params.id,
      {
        confirmOrderLiCleared: (
          req.body?.confirm_order_li_cleared === true
        )
      }
    );

    res.status(workflow.ok ? 200 : 409).json({
      ok: workflow.ok,
      workflow
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});



// A2000_V4_7_1_ORDER_PREVIEW_REPROCESS_PREFLIGHT
async function sourcePdfForOrder(orderId) {
  const { data: order, error } = await supabase
    .from('purchase_orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (error) throw error;

  if (order.document_id) {
    const docs = await listDocuments({ limit: 1000 });
    const document = docs.find(item => String(item.id) === String(order.document_id));
    if (document) {
      const loaded = await readBufferForStoredDocument(document);
      return {
        ...loaded,
        fileName: document.file_name || order.source_file_name || 'purchase-order.pdf'
      };
    }
  }

  const fileName = path.basename(String(order.source_file_name || '').trim());
  if (fileName) {
    for (const dir of candidateTestPdfDirs()) {
      const candidate = path.join(dir, fileName);
      try {
        const stat = await fs.stat(candidate);
        if (stat.isFile()) {
          return {
            buffer: await fs.readFile(candidate),
            source: 'test_pdf_source',
            path: candidate,
            fileName
          };
        }
      } catch {}
    }
  }

  throw new Error('No se encontró el PDF fuente de esta orden.');
}

app.get('/po/orders/:id/pdf', async (req, res) => {
  try {
    const loaded = await sourcePdfForOrder(req.params.id);
    const fileName = String(loaded.fileName || 'purchase-order.pdf').replaceAll('"', '');
    const disposition = String(req.query.download || '') === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `${disposition}; filename="${fileName}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(loaded.buffer);
  } catch (error) {
    res.status(404).json({ ok: false, error: error.message });
  }
});

app.post('/po/orders/:id/reprocess', async (req, res) => {
  try {
    const { data: order, error } = await supabase
      .from('purchase_orders')
      .select('id, document_id, order_no, source_file_name')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!order.document_id) {
      return res.status(409).json({
        ok: false,
        code: 'SOURCE_DOCUMENT_NOT_PERSISTED',
        error: 'Esta orden proviene de un histórico o test-pdfs. Puede abrirse y revisarse, pero no tiene document_id para reprocesarla en Supabase.'
      });
    }

    const workflow = await processDocumentWorkflow(order.document_id, {
      uploadToA2000: false,
      confirmOrderLiCleared: false
    });
    res.status(workflow.ok ? 200 : 409).json({ ok: workflow.ok, workflow });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/po/orders/:id/preflight', async (req, res) => {
  try {
    const workflow = await preflightOrderWorkflow(req.params.id);
    res.status(workflow.ok ? 200 : 409).json({
      ok: workflow.ok,
      workflow,
      a2000_write_performed: false
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      a2000_write_performed: false
    });
  }
});


// A2000_V4_7_0_CHECKLIST_BULK_ENDPOINTS
app.get('/po/checklists/status', async (_req, res) => {
  try {
    const catalog = await checklistCatalog();
    res.json({ ok: true, ...catalog });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/po/checklists/rebuild', async (_req, res) => {
  try {
    const catalog = await rebuildChecklistCatalog();
    res.json({ ok: true, ...catalog });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/po/orders/:id/checklist', async (req, res) => {
  try {
    const result = await generateChecklistForOrder(req.params.id, {
      rebuildCatalog: req.body?.rebuild_catalog === true
    });
    res.status(result.ok ? 200 : 409).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/po/orders/:id/checklist/download', async (req, res) => {
  try {
    let filePath = await checklistDownloadPath(req.params.id);
    if (!filePath) {
      const generated = await generateChecklistForOrder(req.params.id);
      if (!generated.ok) return res.status(404).json(generated);
      filePath = generated.file_path;
    }
    res.download(filePath, path.basename(filePath));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/po/upload-all-validated', async (req, res) => {
  try {
    const result = await uploadAllValidatedOrders({
      limit: Number(req.body?.limit || 50),
      confirmOrderLiCleared: req.body?.confirm_order_li_cleared === true
    });
    res.status(result.ok ? 200 : 409).json({ ok: result.ok, workflow: result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get('/documents', async (_req, res) => {
  try {
    res.json(await listDocuments());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/events', async (req, res) => {
  try {
    const showAll = String(req.query.all || '') === '1';
    const subjectFilter = String(req.query.subject || DEFAULT_INVOICE_SUBJECT_FILTER);
    const limit = Number(req.query.limit || 500);
    const events = await listEvents({ limit });
    const filtered = showAll ? events : events.filter(event => subjectMatchesFilter(event, subjectFilter));

    res.json(filtered.map(event => ({
      ...event,
      dashboard_scope: showAll ? 'all_email_events' : 'invoice_subject_filter',
      dashboard_subject_filter: subjectFilter
    })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/events/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['new', 'reviewed', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    res.json(await markEvent(req.params.id, status));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// RPA_OUTLOOK_RUNSCAN_ATOMIC_REPAIR_V2
// RPA_OUTLOOK_RUNSCAN_ATOMIC_REPAIR_V2
// RPA_OUTLOOK_RUNSCAN_ATOMIC_REPAIR_V2
let running = false;
let scanStatus = {
  running: false,
  status: 'idle',
  started_at: null,
  finished_at: null,
  error: null,
  result: null
};

function runScanError(result = {}) {
  const failed = (
    result?.ok === false
    || result?.run?.status === 'error'
  );

  if (!failed) return null;

  return (
    result?.error
    || result?.run?.error_message
    || result?.run?.finish_error
    || 'Outlook RPA terminó con error.'
  );
}

function publicRunScanResult(result = {}) {
  const emails = Array.isArray(result?.emails)
    ? result.emails
    : [];

  const documents = Array.isArray(result?.documents)
    ? result.documents
    : [];

  return {
    ok: result?.ok !== false,
    version: result?.version || null,
    error: runScanError(result),
    run: result?.run || null,
    emails,
    documents,
    email_count: emails.length,
    document_count: documents.length,
    processing: result?.processing || null,
    customer_identifiers: result?.customer_identifiers || null,
    logs: Array.isArray(result?.logs) ? result.logs : []
  };
}

app.get('/run-scan/dependencies', (_req, res) => {
  const status = runScanDependencyStatus();

  res.status(status.ok ? 200 : 500).json(status);
});

app.get('/run-scan/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(scanStatus);
});

app.post('/run-scan', async (_req, res) => {
  if (running) {
    return res.status(202).json({
      ok: true,
      accepted: true,
      already_running: true,
      message: 'Outlook RPA is already running',
      status_url: '/run-scan/status',
      ...scanStatus
    });
  }

  running = true;
  scanStatus = {
    running: true,
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    result: null
  };

  res.status(202).json({
    ok: true,
    accepted: true,
    message: 'Outlook RPA started',
    status_url: '/run-scan/status',
    ...scanStatus
  });

  void runScan()
    .then(result => {
      const error = runScanError(result);
      const runError = Boolean(error);

      scanStatus = {
        running: false,
        status: runError ? 'error' : 'completed',
        started_at: scanStatus.started_at,
        finished_at: new Date().toISOString(),
        error,
        result: publicRunScanResult(result)
      };
    })
    .catch(error => {
      scanStatus = {
        running: false,
        status: 'error',
        started_at: scanStatus.started_at,
        finished_at: new Date().toISOString(),
        error: error.message,
        result: {
          ok: false,
          error: error.message,
          run: null,
          emails: [],
          documents: [],
          email_count: 0,
          document_count: 0,
          processing: null,
          customer_identifiers: null,
          logs: [error.message]
        }
      };
    })
    .finally(() => {
      running = false;
    });
});

app.listen(config.port, () => {
  console.log(`API running on http://localhost:${config.port}`);
  console.log(`Invoice subject filter: ${DEFAULT_INVOICE_SUBJECT_FILTER}`);
  startOperationalExtensions().catch(error => {
    console.error('Operational extensions failed to start:', error.message);
  });
});
