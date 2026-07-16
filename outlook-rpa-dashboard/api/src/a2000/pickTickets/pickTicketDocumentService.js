import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { supabase } from '../../supabase.js';
import { extractPdfTextFromBuffer } from '../../po/pdfText.js';
import {
  buildAuthoritativeChecklistInput,
  identifiersFromPickTicketName,
  identifiersFromPickTicketText,
  isBulkParentIdentity,
  mergePickTicketIdentity
} from './pickTicketCore.js';
import {
  parsePickTicketPdfText
} from './pickTicketPdfParser.js';
import {
  correlatePickTicketOrder,
  orderNumberCandidates
} from './pickTicketSnapshotCore.js';
import {
  generateChecklistForPickTicketDocument
} from './controlChecklistService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_WATCH_DIR = path.join(
  API_ROOT,
  'storage',
  'pick-tickets'
);
const CHECKLIST_INPUT_DIR = path.join(
  API_ROOT,
  'storage',
  'checklist-inputs'
);

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function boolEnv(value, fallback = true) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return ['true', '1', 'yes', 'y'].includes(
    String(value).toLowerCase()
  );
}

function normalizePart(value = '') {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'unknown';
}

function deepFind(object, names = []) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const seen = new Set();

  function visit(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) {
      return '';
    }
    seen.add(value);

    for (const [key, item] of Object.entries(value)) {
      if (wanted.has(key.toLowerCase()) && clean(item)) {
        return clean(item);
      }
    }

    for (const item of Object.values(value)) {
      const found = visit(item);
      if (found) return found;
    }

    return '';
  }

  return visit(object);
}

function identityFromMetadata(metadata = {}) {
  return {
    pick_ticket_no: deepFind(metadata, [
      'pick_ticket_no', 'pick_ticket', 'picktkt', 'pt_no'
    ]),
    control_no: deepFind(metadata, [
      'control_no', 'ctrl_no', 'control', 'ctrl'
    ]),
    order_no: deepFind(metadata, [
      'order_no', 'po_number', 'po_no', 'purchase_order'
    ]),
    store_code: deepFind(metadata, [
      'store_code', 'store_no', 'store', 'ship_to'
    ]),
    customer_code: deepFind(metadata, [
      'customer_code', 'customer', 'cust_no'
    ]),
    classification: deepFind(metadata, [
      'classification', 'distrop_classification'
    ]),
    record_type: deepFind(metadata, [
      'record_type', 'type'
    ])
  };
}

async function listFilesRecursive(dir) {
  const output = [];
  let entries;

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      output.push(...await listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }

  return output;
}

async function loadAdjacentMetadata(pdfPath) {
  const candidates = [
    pdfPath.replace(/\.pdf$/i, '.json'),
    `${pdfPath}.json`,
    path.join(
      path.dirname(pdfPath),
      `${path.basename(pdfPath, path.extname(pdfPath))}.metadata.json`
    )
  ];

  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf8'));
    } catch {}
  }

  return {};
}

async function ensureBucket() {
  const bucket = clean(
    process.env.PICK_TICKET_STORAGE_BUCKET
    || 'pick-tickets'
  );
  const { data, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  if (!(data || []).some(item => item.name === bucket)) {
    const { error: createError } = await supabase.storage.createBucket(
      bucket,
      {
        public: false,
        fileSizeLimit: 50 * 1024 * 1024
      }
    );

    if (
      createError
      && !/already exists|duplicate/i.test(createError.message || '')
    ) {
      throw createError;
    }
  }

  return bucket;
}

async function allCandidateOrders(identity) {
  let query = supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .order('created_at', { ascending: false })
    .limit(100);

  if (identity.customer_code) {
    query = query.eq('customer_code', identity.customer_code);
  }

  const { data, error } = await query;
  if (error) throw error;

  const seen = new Set();
  return (data || []).filter(order => {
    const lineSignature = (order.purchase_order_lines || [])
      .map(line => [
        clean(line.style_code),
        clean(line.color_code),
        Number(line.qty_total || 0)
      ].join(':'))
      .sort()
      .join(',');
    const key = [
      clean(order.customer_code).toUpperCase(),
      orderNumberCandidates(order.order_no)[1]
        || clean(order.order_no),
      clean(order.store_code || order.store_raw).toUpperCase(),
      lineSignature
    ].join('|');

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function controlOrderId(controlNo) {
  if (!controlNo) return null;

  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('purchase_order_id,a2000_ctrl_no,a2000_seq_order_no,updated_at')
    .or(
      `a2000_ctrl_no.eq.${controlNo},a2000_seq_order_no.eq.${controlNo}`
    )
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error || !data?.length) return null;
  return data[0].purchase_order_id || null;
}

async function correlateOrder(identity, lines = []) {
  const orders = await allCandidateOrders(identity);
  const controlPurchaseOrderId = await controlOrderId(
    identity.control_no
  );
  return correlatePickTicketOrder(
    orders,
    {
      ...identity,
      lines,
      picked_quantity: lines.reduce(
        (sum, line) => sum + Number(line.pick_qty || 0),
        0
      )
    },
    { controlPurchaseOrderId }
  );
}

async function existingDocumentByExternalKey(externalKey) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('external_key', externalKey)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) ? data[0] || null : null;
}

async function writeChecklistInput(input) {
  await fs.mkdir(CHECKLIST_INPUT_DIR, { recursive: true });
  const filePath = path.join(
    CHECKLIST_INPUT_DIR,
    [
      normalizePart(input.customer_code),
      normalizePart(input.order_no),
      normalizePart(input.control_no),
      `PT-${normalizePart(input.pick_ticket_no)}.json`
    ].join('_')
  );

  await fs.writeFile(
    filePath,
    JSON.stringify(input, null, 2),
    'utf8'
  );

  return {
    ...input,
    file_path: filePath
  };
}

async function upsertDocument({
  pdfPath,
  buffer,
  identity,
  metadata,
  text,
  section,
  order,
  match,
  checklistInput,
  parserResult,
  pageIndex
}) {
  const bucket = await ensureBucket();
  const sha256 = crypto
    .createHash('sha256')
    .update(buffer)
    .digest('hex');
  const storagePath = [
    normalizePart(identity.customer_code || order?.customer_code),
    normalizePart(identity.order_no || order?.order_no),
    normalizePart(identity.control_no),
    `PT-${normalizePart(identity.pick_ticket_no)}-${sha256.slice(0, 10)}.pdf`
  ].join('/');

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType: 'application/pdf',
      upsert: true
    });
  if (uploadError) throw uploadError;

  const externalKey = [
    'a2000-pick-ticket',
    identity.control_no,
    identity.pick_ticket_no
  ].join('|');
  const current = await existingDocumentByExternalKey(externalKey);
  const previousRaw = current?.raw && typeof current.raw === 'object'
    ? current.raw
    : {};

  const row = {
    external_key: externalKey,
    source: 'a2000_pick_ticket_observer',
    email_external_key: null,
    subject: (
      `Pick Ticket ${identity.pick_ticket_no} `
      + `Control ${identity.control_no}`
    ),
    sender_name: 'A2000 PICKCP observer',
    sender_email: null,
    file_name: path.basename(pdfPath),
    storage_bucket: bucket,
    storage_path: storagePath,
    file_size: buffer.length,
    sha256,
    status: order
      ? 'pick_ticket_ready'
      : 'pick_ticket_unmatched',
    detected_customer: identity.customer_code
      || order?.customer_code
      || null,
    detected_po: identity.order_no
      || order?.order_no
      || null,
    ocr_text: section || text,
    raw: {
      ...previousRaw,
      document_type: 'pick_ticket_pdf',
      authoritative_source: 'pick_ticket_pdf',
      pick_ticket_no: identity.pick_ticket_no,
      control_no: identity.control_no,
      order_no: identity.order_no || order?.order_no || null,
      store_code: identity.store_code || order?.store_code || null,
      customer_code: identity.customer_code
        || order?.customer_code
        || null,
      purchase_order_id: order?.id || previousRaw.purchase_order_id || null,
      control_identity: checklistInput?.control_identity
        || previousRaw.control_identity
        || null,
      source_precedence: (
        'PICK_TICKET_PDF_THEN_SNAPSHOT_THEN_HARDCOPY'
      ),
      checklist_input_path: checklistInput?.file_path
        || previousRaw.checklist_input_path
        || null,
      checklist_conflict_count: checklistInput?.conflict_count
        ?? previousRaw.checklist_conflict_count
        ?? 0,
      checklist_status: order
        ? previousRaw.checklist_status === 'generated'
          ? 'generated'
          : 'authoritative_input_ready'
        : 'waiting_for_exact_order_match',
      observer_metadata: metadata,
      parser_result: parserResult,
      pdf_page_index: pageIndex,
      match_reason: match?.reason || previousRaw.match_reason || null,
      match_score: match?.score || previousRaw.match_score || 0,
      localPath: pdfPath,
      pdf_available: true,
      pdf_storage_bucket: bucket,
      pdf_storage_path: storagePath,
      pdf_sha256: sha256,
      persisted_at: new Date().toISOString()
    }
  };

  let data;
  let error;

  if (current) {
    ({ data, error } = await supabase
      .from('documents')
      .update(row)
      .eq('id', current.id)
      .select('*')
      .single());
  } else {
    ({ data, error } = await supabase
      .from('documents')
      .upsert(row, { onConflict: 'external_key' })
      .select('*')
      .single());
  }

  if (error) throw error;
  return data;
}

async function persistParsedPickTicket({
  pdfPath,
  buffer,
  text,
  metadata,
  parsed,
  fallbackIdentity
}) {
  const identity = mergePickTicketIdentity(
    identityFromMetadata(metadata),
    parsed.identity,
    fallbackIdentity
  );

  if (!identity.pick_ticket_no || !identity.control_no) {
    return {
      ok: false,
      stage: 'pick_ticket_identity_incomplete',
      pdf_path: pdfPath,
      identity,
      page_index: parsed.page_index
    };
  }

  if (isBulkParentIdentity(identity)) {
    return {
      ok: true,
      stage: 'bulk_parent_excluded',
      pdf_path: pdfPath,
      identity,
      page_index: parsed.page_index
    };
  }

  const externalKey = [
    'a2000-pick-ticket',
    identity.control_no,
    identity.pick_ticket_no
  ].join('|');
  const previousDocument = await existingDocumentByExternalKey(
    externalKey
  );
  const snapshotLines = previousDocument?.raw
    ?.pick_ticket_snapshot?.lines || [];
  const effectivePickTicketLines = parsed.lines.length
    ? parsed.lines
    : snapshotLines;
  const effectivePickTicketSource = parsed.lines.length
    ? 'pick_ticket_pdf'
    : 'pick_ticket_snapshot';

  const match = await correlateOrder(
    identity,
    effectivePickTicketLines
  );
  const order = match.order;
  const checklistInput = order
    ? await writeChecklistInput(
        buildAuthoritativeChecklistInput({
          order,
          identity: {
            ...identity,
            customer_code: identity.customer_code
              || order.customer_code,
            order_no: identity.order_no
              || order.order_no,
            store_code: identity.store_code
              || order.store_code,
            warehouse_code: identity.warehouse_code
              || order.warehouse_code
          },
          pickTicketLines: effectivePickTicketLines,
          pickTicketSource: effectivePickTicketSource
        })
      )
    : null;
  const document = await upsertDocument({
    pdfPath,
    buffer,
    identity,
    metadata,
    text,
    section: parsed.raw_text,
    order,
    match,
    checklistInput,
    parserResult: parsed,
    pageIndex: parsed.page_index
  });
  let checklist = null;

  if (
    order
    && boolEnv(process.env.PICK_TICKET_AUTO_CHECKLIST_ENABLED, true)
  ) {
    try {
      checklist = await generateChecklistForPickTicketDocument(
        document.id,
        { force: true }
      );
    } catch (error) {
      checklist = {
        ok: false,
        generated: false,
        reason: 'PICK_TICKET_CHECKLIST_GENERATION_ERROR',
        error: error.message
      };
    }
  }

  return {
    ok: true,
    stage: order
      ? 'pick_ticket_persisted_and_matched'
      : 'pick_ticket_persisted_unmatched',
    document_id: document.id,
    purchase_order_id: order?.id || null,
    identity,
    match_reason: match.reason,
    match_score: match.score,
    page_index: parsed.page_index,
    pick_ticket_line_source: effectivePickTicketSource,
    checklist_input: checklistInput,
    checklist
  };
}

export async function persistPickTicketPdf(pdfPath) {
  const buffer = await fs.readFile(pdfPath);
  const text = await extractPdfTextFromBuffer(buffer);
  const metadata = await loadAdjacentMetadata(pdfPath);
  const fallbackIdentity = mergePickTicketIdentity(
    identityFromMetadata(metadata),
    identifiersFromPickTicketName(path.basename(pdfPath)),
    identifiersFromPickTicketText(text)
  );
  const parsedPages = parsePickTicketPdfText(text);

  if (!parsedPages.length) {
    parsedPages.push({
      page_index: 1,
      identity: fallbackIdentity,
      lines: [],
      raw_text: text
    });
  }

  const results = [];

  for (const parsed of parsedPages) {
    results.push(await persistParsedPickTicket({
      pdfPath,
      buffer,
      text,
      metadata,
      parsed,
      fallbackIdentity
    }));
  }

  return {
    ok: results.every(item => item.ok),
    pdf_path: pdfPath,
    pick_ticket_count: results.filter(
      item => item.ok
      && item.stage !== 'bulk_parent_excluded'
    ).length,
    matched_count: results.filter(
      item => item.stage === 'pick_ticket_persisted_and_matched'
    ).length,
    unmatched_count: results.filter(
      item => item.stage === 'pick_ticket_persisted_unmatched'
    ).length,
    excluded_parent_count: results.filter(
      item => item.stage === 'bulk_parent_excluded'
    ).length,
    results
  };
}

const processedFileState = new Map();

async function fileSignature(file) {
  const stat = await fs.stat(file);
  return `${stat.size}|${stat.mtimeMs}`;
}

export async function reconcilePickTicketDirectory({
  directory = process.env.A2000_PICK_TICKET_OUTPUT_DIR
    || DEFAULT_WATCH_DIR,
  force = false
} = {}) {
  const files = (await listFilesRecursive(directory))
    .filter(file => /\.pdf$/i.test(file));
  const results = [];
  let skippedUnchanged = 0;

  for (const file of files) {
    try {
      const signature = await fileSignature(file);

      if (!force && processedFileState.get(file) === signature) {
        skippedUnchanged += 1;
        continue;
      }

      const result = await persistPickTicketPdf(file);
      results.push(result);

      if (result.ok) processedFileState.set(file, signature);
    } catch (error) {
      results.push({
        ok: false,
        stage: 'pick_ticket_persistence_error',
        pdf_path: file,
        error: error.message
      });
    }
  }

  return {
    ok: results.every(item => item.ok),
    directory,
    pdf_count: files.length,
    processed_pdf_count: results.length,
    skipped_unchanged_count: skippedUnchanged,
    pick_ticket_count: results.reduce(
      (sum, item) => sum + Number(item.pick_ticket_count || 0),
      0
    ),
    matched_count: results.reduce(
      (sum, item) => sum + Number(item.matched_count || 0),
      0
    ),
    unmatched_count: results.reduce(
      (sum, item) => sum + Number(item.unmatched_count || 0),
      0
    ),
    excluded_parent_count: results.reduce(
      (sum, item) => sum + Number(item.excluded_parent_count || 0),
      0
    ),
    results
  };
}

export async function listPickTicketDocuments({ limit = 500 } = {}) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .in('source', [
      'a2000_pick_ticket_observer',
      'a2000_pick_ticket_snapshot'
    ])
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data || []).map(item => ({
    ...item,
    pick_ticket_no: item.raw?.pick_ticket_no || null,
    control_no: item.raw?.control_no || null,
    order_no: item.raw?.order_no || item.detected_po || null,
    store_code: item.raw?.store_code || null,
    customer_code: item.raw?.customer_code
      || item.detected_customer
      || null,
    purchase_order_id: item.raw?.purchase_order_id || null,
    checklist_status: item.raw?.checklist_status || null,
    checklist_input_path: item.raw?.checklist_input_path || null,
    checklist_conflict_count: item.raw?.checklist_conflict_count || 0,
    checklist_available: Boolean(
      item.raw?.generated_checklist_path
    ),
    checklist_file_name: item.raw?.generated_checklist_file_name || null,
    pdf_available: item.raw?.pdf_available === true,
    snapshot_available: Boolean(item.raw?.pick_ticket_snapshot),
    snapshot_line_count: item.raw?.pick_ticket_snapshot?.lines?.length || 0,
    picked_quantity: item.raw?.pick_ticket_snapshot?.picked_quantity || 0,
    match_reason: item.raw?.match_reason || null,
    match_score: item.raw?.match_score || 0
  }));
}

export async function pickTicketPdfByDocumentId(documentId) {
  const { data: document, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .in('source', [
      'a2000_pick_ticket_observer',
      'a2000_pick_ticket_snapshot'
    ])
    .single();
  if (error) throw error;

  if (document.raw?.pdf_available !== true) {
    throw new Error(
      'Pick Ticket data is available, but the PDF has not been rendered yet.'
    );
  }

  const localPath = document.raw?.localPath;
  if (localPath) {
    try {
      return {
        buffer: await fs.readFile(localPath),
        file_name: document.file_name
      };
    } catch {}
  }

  const bucket = document.raw?.pdf_storage_bucket
    || document.storage_bucket;
  const storagePath = document.raw?.pdf_storage_path
    || document.storage_path;
  const { data, error: downloadError } = await supabase.storage
    .from(bucket)
    .download(storagePath);
  if (downloadError) throw downloadError;

  return {
    buffer: Buffer.from(await data.arrayBuffer()),
    file_name: document.file_name
  };
}

let watcherTimer = null;
let watcherRunning = false;
let watcherState = {
  started: false,
  running: false,
  last_started_at: null,
  last_completed_at: null,
  last_error: null,
  last_result: null
};

export function pickTicketPersistenceWatcherStatus() {
  return { ...watcherState };
}

export function startPickTicketPersistenceWatcher() {
  if (watcherTimer) return watcherTimer;
  if (!boolEnv(process.env.A2000_PICK_TICKET_PERSISTENCE_ENABLED, true)) {
    watcherState = {
      ...watcherState,
      started: false,
      last_error: 'DISABLED_BY_ENV'
    };
    return null;
  }

  const pollMs = Math.max(
    5000,
    Number(process.env.A2000_PICK_TICKET_POLL_MS || 15000)
  );

  const run = async () => {
    if (watcherRunning) return;
    watcherRunning = true;
    watcherState = {
      ...watcherState,
      started: true,
      running: true,
      last_started_at: new Date().toISOString(),
      last_error: null
    };

    try {
      const result = await reconcilePickTicketDirectory();
      watcherState = {
        ...watcherState,
        running: false,
        last_completed_at: new Date().toISOString(),
        last_result: {
          pdf_count: result.pdf_count,
          processed_pdf_count: result.processed_pdf_count,
          pick_ticket_count: result.pick_ticket_count,
          matched_count: result.matched_count,
          unmatched_count: result.unmatched_count
        }
      };

      if (result.processed_pdf_count) {
        console.log(
          `[pick-ticket-persistence] PDFs=${result.pdf_count} `
          + `processed=${result.processed_pdf_count} `
          + `PTs=${result.pick_ticket_count} `
          + `matched=${result.matched_count} `
          + `unmatched=${result.unmatched_count}`
        );
      }
    } catch (error) {
      watcherState = {
        ...watcherState,
        running: false,
        last_completed_at: new Date().toISOString(),
        last_error: error.message
      };
      console.error(
        '[pick-ticket-persistence] error:',
        error.message
      );
    } finally {
      watcherRunning = false;
    }
  };

  run();
  watcherTimer = setInterval(run, pollMs);
  watcherTimer.unref?.();
  return watcherTimer;
}
