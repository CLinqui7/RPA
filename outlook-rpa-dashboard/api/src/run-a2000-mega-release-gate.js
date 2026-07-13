import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfTextFromBuffer } from './po/pdfText.js';
import { parsePurchaseOrders } from './po/parsers/index.js';
import { A2000RestAdapter } from './a2000/restAdapter.js';
import { saveDownloadedDocuments } from './documentRepository.js';
import { processDownloadedDocuments } from './po/poRepository.js';
import { supabase } from './supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..', '..');
const EXPECTED_FILE = 'PurchaseOrder-0000199431-00-009721.pdf';
const EXPECTED_ORDER_NO = '0000199431';
const EXPECTED_CUSTOMER = 'CITI';
const RUN_ID = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const OUT = path.join('/tmp', `a2000_mega_release_gate_v4_3_${RUN_ID}`);
await fs.mkdir(OUT, { recursive: true });

const confirmWrite = process.argv.includes('--confirm-write');
const confirmOrderLiCleared = process.argv.includes('--confirm-order-li-cleared');
if (confirmOrderLiCleared) process.env.A2000_ORDER_LI_CLEARED = 'YES';

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function isAmexTest(value) {
  const normalized = clean(value).toLowerCase();
  return normalized.includes('amextest.a2000cloud.com') && normalized.includes('/ords/amxtest');
}

function activeBuckets(line = {}) {
  const result = {};
  for (let index = 1; index <= 18; index += 1) {
    const value = Number(line[`qty_sz${index}`] || 0);
    if (Number.isFinite(value) && value > 0) result[`QTY_SZ${index}`] = value;
  }
  return result;
}

function flattenParsedOrder(parsed = {}) {
  const header = parsed.header || {};
  return {
    status: parsed.status,
    parser_name: parsed.parser,
    customer_raw: header.customer_raw || null,
    customer_code: header.customer_code || null,
    order_no: header.order_no || null,
    order_date: header.order_date || null,
    start_date: header.start_date || null,
    cancel_date: header.cancel_date || null,
    book_date: header.book_date || null,
    dept_raw: header.dept_raw || null,
    dept_code: header.dept_code || null,
    division_code: header.division_code || null,
    store_raw: header.store_raw || null,
    store_code: header.store_code || null,
    terms_raw: header.terms_raw || null,
    terms_code: header.terms_code || null,
    ship_via_code: header.ship_via_code || null,
    warehouse_code: header.warehouse_code || null,
    conflicts: parsed.conflicts || [],
    raw_json: parsed,
    purchase_order_lines: (parsed.lines || []).map(line => ({ ...line, raw_json: line.raw || line }))
  };
}

function summarizePreflight(preflight = {}) {
  return {
    valid: preflight.valid === true,
    local_validation_valid: preflight.validation?.valid === true,
    source_guard_valid: preflight.source_guard?.valid === true,
    live_scale_valid: preflight.live_scale_validation?.valid === true,
    live_scale_skipped: preflight.live_scale_validation?.skipped ?? null,
    idempotency_key: preflight.idempotency_key || null,
    errors: preflight.validation?.errors || [],
    source_guard_errors: preflight.source_guard?.errors || [],
    lines: (preflight.live_scale_validation?.lines || []).map(line => ({
      line_no: line.line_no,
      style_code: line.style_code,
      color_code: line.color_code,
      expected_scale: line.expected_scale,
      selected_scales: line.selected_scales,
      valid: line.valid,
      pack_multiplier: line.pack_multiplier,
      errors: line.errors || []
    }))
  };
}

async function walk(directory) {
  const output = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(full));
    else output.push(full);
  }
  return output;
}

async function saveJson(name, value) {
  await fs.writeFile(path.join(OUT, name), JSON.stringify(value, null, 2), 'utf8');
}

async function exactStoredCandidates() {
  const query = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('customer_code', EXPECTED_CUSTOMER)
    .eq('order_no', EXPECTED_ORDER_NO)
    .order('created_at', { ascending: false })
    .limit(20);
  if (query.error) throw query.error;
  return query.data || [];
}

async function ensureCertifiedCitiPersisted(fixturePath, sha256) {
  let candidates = await exactStoredCandidates();
  const alreadyValid = candidates.find(order => order.status === 'parsed' && (order.purchase_order_lines || []).length > 0);
  if (alreadyValid) return { order: alreadyValid, ingested: false, processing: null };

  const externalKey = `certified-hardcopy-fixture|CITI|${EXPECTED_ORDER_NO}|${sha256}`;
  const logs = [];
  const savedDocuments = await saveDownloadedDocuments([
    {
      localPath: fixturePath,
      fileName: EXPECTED_FILE,
      externalKey,
      emailExternalKey: `certified-fixture-citi-${EXPECTED_ORDER_NO}`,
      subject: `Certified CITI hardcopy ${EXPECTED_ORDER_NO}`,
      senderName: 'Certified hardcopy fixture',
      senderEmail: null,
      downloadedAt: new Date().toISOString(),
      raw: {
        pilot_fixture: true,
        customer_code: EXPECTED_CUSTOMER,
        expected_order_no: EXPECTED_ORDER_NO,
        source_policy: 'official_masters_only',
        fixture_sha256: sha256,
        purpose: 'mega_release_gate_controlled_amextest_pilot'
      }
    }
  ], logs, { allowDuplicates: false, runId: `mega-release-citi-${EXPECTED_ORDER_NO}` });

  if (savedDocuments.length !== 1) {
    throw new Error(`EXPECTED_ONE_SAVED_DOCUMENT_GOT_${savedDocuments.length}`);
  }

  const processing = await processDownloadedDocuments({
    limit: 1,
    documentId: savedDocuments[0].id
  });

  candidates = await exactStoredCandidates();
  const persisted = candidates.find(order => order.status === 'parsed' && (order.purchase_order_lines || []).length > 0);
  if (!persisted) throw new Error('CERTIFIED_CITI_NOT_PERSISTED_AFTER_PROCESSING');

  return { order: persisted, ingested: true, processing, logs };
}

function syntheticOrderNo() {
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(-2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `RPAC${yy}${mm}${dd}${hh}${mi}${ss}`;
}

const report = {
  audit: 'A2000_MEGA_RELEASE_GATE_CURRENT_HEAD_SAFE_V4_3',
  run_id: RUN_ID,
  project: PROJECT,
  confirm_write: confirmWrite,
  a2000_write_environment: clean(process.env.A2000_BASE_URL),
  a2000_writes_performed: false,
  supabase_writes_performed: false,
  gates: {}
};

try {
  if (confirmWrite && !isAmexTest(process.env.A2000_BASE_URL)) {
    throw new Error('CONTROLLED_WRITE_HARD_BLOCKED_OUTSIDE_AMEXTEST');
  }

  const saga = await supabase
    .from('a2000_rest_jobs')
    .select('id', { count: 'exact', head: true });
  report.saga = {
    present: !saga.error,
    count: saga.error ? null : saga.count,
    error: saga.error ? { code: saga.error.code || null, message: saga.error.message || String(saga.error) } : null
  };
  if (saga.error) throw new Error(`SAGA_MIGRATION_NOT_READY:${saga.error.message}`);

  const trainingRoot = path.join(PROJECT, 'api', 'training');
  const files = await walk(trainingRoot);
  const fixtureMatches = files.filter(file => path.basename(file).toLowerCase() === EXPECTED_FILE.toLowerCase());
  if (fixtureMatches.length !== 1) throw new Error(`EXPECTED_EXACTLY_ONE_CERTIFIED_CITI_FIXTURE_GOT_${fixtureMatches.length}`);

  const fixturePath = fixtureMatches[0];
  const buffer = await fs.readFile(fixturePath);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const text = await extractPdfTextFromBuffer(buffer);
  const parsedOrders = parsePurchaseOrders({
    text,
    fileName: EXPECTED_FILE,
    document: {
      file_name: EXPECTED_FILE,
      subject: `Certified CITI hardcopy ${EXPECTED_ORDER_NO}`,
      source: 'certified_hardcopy_fixture'
    }
  });

  if (parsedOrders.length !== 1) throw new Error(`CERTIFIED_CITI_PARSED_ORDER_COUNT_${parsedOrders.length}`);
  const parsed = parsedOrders[0];
  const header = parsed.header || {};
  const parseGuards = {
    parser_cititrends: parsed.parser === 'cititrends',
    status_parsed: parsed.status === 'parsed',
    customer_citi: header.customer_code === EXPECTED_CUSTOMER,
    order_no_exact: header.order_no === EXPECTED_ORDER_NO,
    no_header_missing: (header.missing_fields || []).length === 0,
    no_line_missing: (parsed.needs_mapping?.lines || []).length === 0,
    no_blocking_conflicts: !(parsed.conflicts || []).some(item => item.blocking === true),
    has_lines: (parsed.lines || []).length > 0
  };
  report.fixture = { fixture_path: fixturePath, sha256, bytes: buffer.length };
  report.parse = {
    guards: parseGuards,
    guards_valid: Object.values(parseGuards).every(Boolean),
    parser: parsed.parser,
    status: parsed.status,
    customer_code: header.customer_code,
    order_no: header.order_no,
    line_count: (parsed.lines || []).length,
    lines: (parsed.lines || []).map(line => ({
      line_no: line.line_no,
      style_code: line.style_code,
      color_code: line.color_code,
      sales_price: line.sales_price,
      scale_code: line.scale_code,
      buckets: activeBuckets(line)
    }))
  };
  if (!report.parse.guards_valid) throw new Error('CERTIFIED_CITI_PARSE_GUARDS_FAILED');

  const adapter = new A2000RestAdapter();
  const memoryOrder = flattenParsedOrder(parsed);
  const memoryPreflight = await adapter.preflight(memoryOrder);
  report.memory_preflight = summarizePreflight(memoryPreflight);
  if (!memoryPreflight.valid) throw new Error('CERTIFIED_CITI_MEMORY_PREFLIGHT_FAILED');

  const persistence = await ensureCertifiedCitiPersisted(fixturePath, sha256);
  report.supabase_writes_performed = persistence.ingested;
  report.persistence = {
    ingested_now: persistence.ingested,
    processing: persistence.processing,
    purchase_order_id: persistence.order.id,
    document_id: persistence.order.document_id,
    status: persistence.order.status,
    customer_code: persistence.order.customer_code,
    order_no: persistence.order.order_no,
    line_count: (persistence.order.purchase_order_lines || []).length
  };

  const persistedPreflight = await adapter.preflight(persistence.order);
  report.persisted_preflight = summarizePreflight(persistedPreflight);
  if (!persistedPreflight.valid) throw new Error('CERTIFIED_CITI_PERSISTED_PREFLIGHT_FAILED');

  report.gates = {
    saga_migration_present: report.saga.present,
    parse_guards_valid: report.parse.guards_valid,
    memory_preflight_valid: memoryPreflight.valid,
    persisted_preflight_valid: persistedPreflight.valid,
    amextest_for_write: confirmWrite ? isAmexTest(process.env.A2000_BASE_URL) : null,
    order_li_clear_confirmed: confirmWrite ? clean(process.env.A2000_ORDER_LI_CLEARED).toUpperCase() === 'YES' : null
  };

  if (!confirmWrite) {
    report.final_valid = Object.values({
      saga: report.gates.saga_migration_present,
      parse: report.gates.parse_guards_valid,
      memory: report.gates.memory_preflight_valid,
      persisted: report.gates.persisted_preflight_valid
    }).every(Boolean);
    report.next = report.final_valid
      ? 'MANUAL_ORDER_LI_INSPECT_EXPORT_CLEAR_THEN_RERUN_WITH_CONFIRM_WRITE'
      : 'STOP';
  } else {
    if (clean(process.env.A2000_ORDER_LI_CLEARED).toUpperCase() !== 'YES') {
      throw new Error('ORDER_LI_CLEAR_NOT_CONFIRMED');
    }

    const testOrderNo = syntheticOrderNo();
    const controlledOrder = {
      ...persistence.order,
      order_no: testOrderNo,
      raw_json: {
        ...(persistence.order.raw_json || {}),
        controlled_amxtest_release_gate: true,
        source_order_no: persistence.order.order_no,
        synthetic_test_order_no: testOrderNo,
        run_id: RUN_ID
      },
      purchase_order_lines: (persistence.order.purchase_order_lines || []).map(line => ({ ...line }))
    };

    const controlledPreflight = await adapter.preflight(controlledOrder);
    report.controlled_write = {
      synthetic_order_no: testOrderNo,
      source_order_no: persistence.order.order_no,
      preflight: summarizePreflight(controlledPreflight)
    };
    if (!controlledPreflight.valid) throw new Error('CONTROLLED_SYNTHETIC_ORDER_PREFLIGHT_FAILED');

    const firstWrite = await adapter.uploadOrder(controlledOrder, { confirmWrite: true });
    report.a2000_writes_performed = true;
    report.controlled_write.first = firstWrite;
    if (!firstWrite.ok) throw new Error(`CONTROLLED_WRITE_FAILED_STAGE_${firstWrite.stage}`);

    const secondWrite = await adapter.uploadOrder(controlledOrder, { confirmWrite: true });
    report.controlled_write.second_idempotency_check = secondWrite;
    if (!secondWrite.ok) throw new Error(`IDEMPOTENCY_RECHECK_FAILED_STAGE_${secondWrite.stage}`);

    const jobQuery = await supabase
      .from('a2000_rest_jobs')
      .select('*')
      .eq('idempotency_key', controlledPreflight.idempotency_key)
      .maybeSingle();
    if (jobQuery.error) throw jobQuery.error;
    report.controlled_write.saga_job = jobQuery.data || null;

    const firstCompleted = ['completed', 'completed_existing', 'completed_after_reconciliation', 'completed_after_lines_transport_reconciliation', 'completed_existing_lines_verified'].some(token => String(firstWrite.stage || '').includes(token));
    const secondIdempotent = secondWrite.idempotent === true || String(secondWrite.stage || '').includes('completed_existing');
    const sagaCompleted = jobQuery.data?.status === 'completed';
    report.controlled_write.verdict = {
      first_write_ok: firstWrite.ok === true,
      first_write_completed_stage: firstCompleted,
      second_call_ok: secondWrite.ok === true,
      second_call_idempotent: secondIdempotent,
      saga_completed: sagaCompleted,
      a2000_seq_order_no: jobQuery.data?.a2000_seq_order_no || null,
      a2000_ctrl_no: jobQuery.data?.a2000_ctrl_no || null
    };
    report.final_valid = Object.values({
      first_write_ok: firstWrite.ok === true,
      first_write_completed_stage: firstCompleted,
      second_call_ok: secondWrite.ok === true,
      second_call_idempotent: secondIdempotent,
      saga_completed: sagaCompleted
    }).every(Boolean);
    report.next = report.final_valid
      ? 'AMEXTEST_END_TO_END_WRITE_CERTIFIED_BEGIN_CITI_STAGE1_RELEASE_PREP'
      : 'STOP_AND_REVIEW_CONTROLLED_WRITE_REPORT';
  }

  await saveJson('FULL_REPORT.json', report);

  const lines = [
    '='.repeat(88),
    'COPY THIS RESULT TO CHATGPT',
    '='.repeat(88),
    'MEGA_GATE=A2000_MEGA_RELEASE_GATE_CURRENT_HEAD_SAFE_V4_3',
    `RUN_ID=${RUN_ID}`,
    `CONFIRM_WRITE=${confirmWrite}`,
    `A2000_WRITES_PERFORMED=${report.a2000_writes_performed ? 'YES' : 'NO'}`,
    `SUPABASE_WRITES_PERFORMED=${report.supabase_writes_performed ? 'YES' : 'NO'}`,
    `A2000_BASE_URL=${report.a2000_write_environment}`,
    '',
    '=== SAGA ===',
    `SAGA_MIGRATION_PRESENT=${report.saga.present}`,
    `SAGA_JOB_COUNT_BEFORE=${report.saga.count}`,
    '',
    '=== CERTIFIED CITI SOURCE ===',
    `FIXTURE=${fixturePath}`,
    `FIXTURE_SHA256=${sha256}`,
    `PARSE_GUARDS_VALID=${report.parse.guards_valid}`,
    `PARSER=${parsed.parser}`,
    `STATUS=${parsed.status}`,
    `CUSTOMER_CODE=${header.customer_code}`,
    `SOURCE_ORDER_NO=${header.order_no}`,
    `LINE_COUNT=${(parsed.lines || []).length}`,
    `MEMORY_PREFLIGHT_VALID=${memoryPreflight.valid}`,
    '',
    '=== PERSISTENCE ===',
    `INGESTED_NOW=${persistence.ingested}`,
    `PURCHASE_ORDER_ID=${persistence.order.id}`,
    `PERSISTED_STATUS=${persistence.order.status}`,
    `PERSISTED_PREFLIGHT_VALID=${persistedPreflight.valid}`,
    '',
    '=== RELEASE GATES ===',
    `GATES=${JSON.stringify(report.gates)}`,
  ];

  if (confirmWrite) {
    lines.push('');
    lines.push('=== CONTROLLED AMEXTEST WRITE ===');
    lines.push(`SYNTHETIC_ORDER_NO=${report.controlled_write.synthetic_order_no}`);
    lines.push(`CONTROLLED_PREFLIGHT_VALID=${report.controlled_write.preflight.valid}`);
    lines.push(`FIRST_WRITE_STAGE=${report.controlled_write.first?.stage || ''}`);
    lines.push(`SECOND_CALL_STAGE=${report.controlled_write.second_idempotency_check?.stage || ''}`);
    lines.push(`IDEMPOTENCY_VERDICT=${JSON.stringify(report.controlled_write.verdict)}`);
  }

  lines.push('');
  lines.push('=== FINAL ===');
  lines.push(`FINAL_VALID=${report.final_valid}`);
  lines.push(`NEXT=${report.next}`);
  lines.push(`FULL_REPORT=${path.join(OUT, 'FULL_REPORT.json')}`);
  lines.push(`MEGA_GATE_DIR=${OUT}`);
  lines.push('='.repeat(88));

  const copyText = lines.join('\n') + '\n';
  await fs.writeFile(path.join(OUT, 'COPY_TO_CHATGPT.txt'), copyText, 'utf8');
  console.log(copyText);
  console.log(`COPY_FILE=${path.join(OUT, 'COPY_TO_CHATGPT.txt')}`);
  console.log(`FULL_REPORT=${path.join(OUT, 'FULL_REPORT.json')}`);
  console.log(`MEGA_GATE_DIR=${OUT}`);
  process.exitCode = report.final_valid ? 0 : 1;
} catch (error) {
  report.error = {
    name: error?.name || 'Error',
    message: error?.message || String(error),
    stack: error?.stack || null
  };
  report.final_valid = false;
  report.next = 'STOP_AND_REVIEW_FULL_REPORT';
  await saveJson('FULL_REPORT.json', report);
  const copyText = [
    '='.repeat(88),
    'COPY THIS RESULT TO CHATGPT',
    '='.repeat(88),
    'MEGA_GATE=A2000_MEGA_RELEASE_GATE_CURRENT_HEAD_SAFE_V4_3',
    `RUN_ID=${RUN_ID}`,
    `CONFIRM_WRITE=${confirmWrite}`,
    `A2000_WRITES_PERFORMED=${report.a2000_writes_performed ? 'YES' : 'NO'}`,
    `SUPABASE_WRITES_PERFORMED=${report.supabase_writes_performed ? 'YES' : 'NO'}`,
    'FINAL_VALID=false',
    `ERROR=${error?.message || String(error)}`,
    `FULL_REPORT=${path.join(OUT, 'FULL_REPORT.json')}`,
    `MEGA_GATE_DIR=${OUT}`,
    '='.repeat(88)
  ].join('\n') + '\n';
  await fs.writeFile(path.join(OUT, 'COPY_TO_CHATGPT.txt'), copyText, 'utf8');
  console.log(copyText);
  console.log(`COPY_FILE=${path.join(OUT, 'COPY_TO_CHATGPT.txt')}`);
  process.exitCode = 1;
}
