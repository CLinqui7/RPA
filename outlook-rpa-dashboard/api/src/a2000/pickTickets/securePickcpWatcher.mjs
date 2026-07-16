import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { PickTicketExpectationStore } from './expectationStore.js';
import { hasPdfMagic, parsePickTicketPdfText, sha256 } from './reportParser.js';
import { correlateReportPages } from './correlation.js';
import { buildChecklistInput } from './checklistInputBuilder.js';

const execFileAsync = promisify(execFile);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function commandExists(command) {
  try {
    execFileSync('bash', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const origin = String(arg(
  'origin',
  process.env.A2000_REPORT_ORIGIN || 'https://amextest.a2000cloud.com:8890'
)).replace(/\/+$/, '');
const server = String(arg('server', process.env.A2000_REPORT_SERVER || 'A2RPTSVR'));
const stateFile = path.resolve(arg(
  'state-file',
  'api/data/pick-ticket-observer/state.json'
));
const outputDir = path.resolve(arg('output-dir', 'api/storage/pick-tickets'));
const quarantineDir = path.resolve(arg(
  'quarantine-dir',
  'api/storage/pick-tickets-quarantine'
));
const intervalMs = Number(arg('interval-ms', '5000'));
const scanAhead = Number(arg('scan-ahead', '100'));
const once = process.argv.includes('--once');

if (!commandExists('pdftotext')) {
  throw new Error(
    'PDFTOTEXT_MISSING: install poppler-utils manually. The installer never installs system packages.'
  );
}
if (!Number.isInteger(scanAhead) || scanAhead < 1) {
  throw new Error('--scan-ahead must be a positive integer.');
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(quarantineDir, { recursive: true });
const store = new PickTicketExpectationStore(stateFile);

async function get(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/pdf,text/xml,text/html,*/*',
      'User-Agent': 'A2000-Secure-PICKCP-Watcher/2.0'
    },
    signal: AbortSignal.timeout(30000)
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    buffer: Buffer.from(await response.arrayBuffer())
  };
}

function xmlValue(xml, pattern) {
  return xml.match(pattern)?.[1] || null;
}

async function inspectJob(jobId) {
  const url = `${origin}/reports/rwservlet/showjobid${jobId}`
    + `?server=${encodeURIComponent(server)}&statusformat=xml`;
  const response = await get(url);
  const xml = response.buffer.toString('latin1');
  const name = xmlValue(xml, /<name>([\s\S]*?)<\/name>/i);
  if (!name) return { exists: false, job_id: jobId };
  return {
    exists: true,
    job_id: jobId,
    name: String(name).trim(),
    status_code: xmlValue(xml, /<status\b[^>]*code=["']([^"']+)["']/i),
    des_type: xmlValue(xml, /<desType>([\s\S]*?)<\/desType>/i),
    des_format: xmlValue(xml, /<desFormat>([\s\S]*?)<\/desFormat>/i),
    owner: xmlValue(xml, /<owner>([\s\S]*?)<\/owner>/i),
    queued_at: xmlValue(xml, /<queued>([\s\S]*?)<\/queued>/i)
  };
}

async function extractText(pdfPath) {
  const textPath = `${pdfPath}.txt`;
  await execFileAsync('pdftotext', ['-layout', pdfPath, textPath], { timeout: 20000 });
  return { textPath, text: await fs.readFile(textPath, 'utf8') };
}

function pendingExpected(state) {
  return Object.values(state.groups || {}).flatMap((group) =>
    (group.expected_pick_tickets || [])
      .filter((item) => item.status !== 'PDF_VALIDATED')
      .map((item) => ({
        ...item,
        group_key: group.group_key,
        baseline_job_id: Number(group.baseline_job_id || 0),
        request_timestamp: group.request_timestamp
      }))
  );
}

async function quarantineMetadata(jobId, metadata) {
  const metadataPath = path.join(quarantineDir, `PICKCP-JOB-${jobId}.json`);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
  return metadataPath;
}

async function processPickcp(job, state) {
  const expected = pendingExpected(state).filter((item) => job.job_id > item.baseline_job_id);
  if (!expected.length) {
    state.unmatched_jobs[String(job.job_id)] = {
      reason: 'NO_PENDING_EXPECTATIONS_AFTER_BASELINE',
      job,
      observed_at: new Date().toISOString()
    };
    return;
  }

  const url = `${origin}/reports/rwservlet/getjobid${job.job_id}`
    + `?server=${encodeURIComponent(server)}`;
  const response = await get(url);
  const validation = {
    http_status: response.status,
    content_type: response.contentType,
    size_bytes: response.buffer.length,
    has_pdf_magic: hasPdfMagic(response.buffer),
    minimum_size_ok: response.buffer.length >= 1024
  };

  if (
    response.status !== 200
    || !/application\/pdf/i.test(response.contentType)
    || !validation.has_pdf_magic
    || !validation.minimum_size_ok
  ) {
    const rejected = {
      reason: 'INVALID_PDF_RESPONSE',
      job,
      validation,
      observed_at: new Date().toISOString()
    };
    rejected.metadata_path = await quarantineMetadata(job.job_id, rejected);
    state.unmatched_jobs[String(job.job_id)] = rejected;
    return;
  }

  const hash = sha256(response.buffer);
  const tempPdf = path.join(
    quarantineDir,
    `PICKCP-JOB-${job.job_id}-${hash.slice(0, 12)}.pdf`
  );
  await fs.writeFile(tempPdf, response.buffer);

  let extracted;
  try {
    extracted = await extractText(tempPdf);
  } catch (error) {
    const rejected = {
      reason: 'PDF_TEXT_EXTRACTION_FAILED',
      job,
      hash,
      pdf_path: tempPdf,
      error: error.message,
      observed_at: new Date().toISOString()
    };
    rejected.metadata_path = await quarantineMetadata(job.job_id, rejected);
    state.unmatched_jobs[String(job.job_id)] = rejected;
    return;
  }

  const pages = parsePickTicketPdfText(extracted.text);
  const correlation = correlateReportPages({ expected, pages });
  if (!correlation.accepted) {
    const rejected = {
      reason: 'PICKCP_CORRELATION_REJECTED',
      job,
      hash,
      pdf_path: tempPdf,
      text_path: extracted.textPath,
      validation,
      correlation,
      observed_at: new Date().toISOString()
    };
    rejected.metadata_path = await quarantineMetadata(job.job_id, rejected);
    state.unmatched_jobs[String(job.job_id)] = rejected;
    return;
  }

  const finalPdf = path.join(
    outputDir,
    `PICKCP-JOB-${job.job_id}-${hash.slice(0, 12)}.pdf`
  );
  await fs.rename(tempPdf, finalPdf);
  const finalText = `${finalPdf}.txt`;
  await fs.rename(extracted.textPath, finalText);

  const touchedGroups = new Set();
  for (const match of correlation.matches) {
    const group = state.groups[match.expected.group_key];
    if (!group) continue;
    const target = group.expected_pick_tickets.find((item) =>
      String(item.pick_ticket_no) === String(match.expected.pick_ticket_no)
      && String(item.control_no) === String(match.expected.control_no)
      && String(item.order_no) === String(match.expected.order_no)
      && String(item.store_no) === String(match.expected.store_no)
    );
    if (!target) continue;
    target.status = 'PDF_VALIDATED';
    target.matched_job_id = job.job_id;
    target.matched_pdf_path = finalPdf;
    target.matched_page_number = match.page_number;
    target.validated_at = new Date().toISOString();
    group.original_report_files = group.original_report_files || [];
    if (!group.original_report_files.includes(finalPdf)) {
      group.original_report_files.push(finalPdf);
    }
    touchedGroups.add(group.group_key);
  }

  state.processed_job_ids[String(job.job_id)] = {
    hash,
    pdf_path: finalPdf,
    text_path: finalText,
    matched_groups: [...touchedGroups],
    processed_at: new Date().toISOString()
  };

  for (const groupKey of touchedGroups) {
    const group = state.groups[groupKey];
    const input = buildChecklistInput(group);
    const safeName = groupKey.replace(/[^A-Za-z0-9._-]+/g, '_');
    const inputPath = path.join(outputDir, `${safeName}.checklist-input.json`);
    await fs.writeFile(inputPath, JSON.stringify(input, null, 2), 'utf8');
    group.checklist_input_path = inputPath;
    group.checklist_status = input.status;
  }

  console.log(JSON.stringify({
    action: 'PICKCP_ACCEPTED',
    job_id: job.job_id,
    pdf_path: finalPdf,
    correlation
  }, null, 2));
}

async function scanOnce() {
  const state = await store.read();
  const pending = pendingExpected(state);
  if (!pending.length) {
    console.log('PENDING_EXPECTATIONS=0');
    return;
  }

  const minimumBaseline = Math.min(...pending.map((item) => item.baseline_job_id));
  const from = Math.max(minimumBaseline + 1, Number(state.last_scanned_job_id || 0) + 1);
  const to = from + scanAhead - 1;
  let highestExisting = Number(state.last_scanned_job_id || 0);
  console.log(`SCAN_RANGE=${from}-${to}`);

  for (let jobId = from; jobId <= to; jobId += 1) {
    if (state.processed_job_ids?.[String(jobId)] || state.unmatched_jobs?.[String(jobId)]) {
      continue;
    }
    const job = await inspectJob(jobId);
    if (!job.exists) continue;
    highestExisting = Math.max(highestExisting, jobId);

    if (
      !/^PICKCP$/i.test(job.name)
      || String(job.status_code) !== '4'
      || !/^cache$/i.test(String(job.des_type))
      || !/^pdf$/i.test(String(job.des_format))
    ) {
      state.processed_job_ids[String(jobId)] = {
        ignored: true,
        reason: 'NOT_SUCCESSFUL_PICKCP_PDF',
        job,
        processed_at: new Date().toISOString()
      };
      continue;
    }
    await processPickcp(job, state);
  }

  if (highestExisting > Number(state.last_scanned_job_id || 0)) {
    state.last_scanned_job_id = highestExisting;
  }
  state.last_scan_at = new Date().toISOString();
  await store.write(state);
}

console.log('A2000 SECURE PICKCP WATCHER V2');
console.log(`STATE_FILE=${stateFile}`);
console.log(`OUTPUT_DIR=${outputDir}`);
console.log('MANUAL_STEP=Person presses Run in A2000. Only exact correlated PICKCP PDFs are accepted.');

do {
  try {
    await scanOnce();
  } catch (error) {
    console.error(`WATCHER_ERROR=${error.stack || error.message}`);
  }
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
} while (true);
