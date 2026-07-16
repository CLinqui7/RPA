import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from '../../supabase.js';
import {
  DEFAULT_CHECKLIST_REGISTRY_PATH,
  resolveChecklistTemplateDetailed
} from '../../checklists/checklistTemplateResolver.js';
import {
  validateChecklistEngineResult
} from '../../checklists/checklistGenerationSafety.js';
import {
  buildChecklistPayloadFromAuthoritativeInput
} from './controlChecklistCore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..', '..', '..');
const ENGINE = path.join(
  API_ROOT,
  'scripts',
  'checklist_template_engine.py'
);
const GENERATED_ROOT = path.join(
  API_ROOT,
  'generated',
  'checklists'
);
const REGISTRY = DEFAULT_CHECKLIST_REGISTRY_PATH;

function clean(value) {
  return value === null || value === undefined
    ? ''
    : String(value).trim();
}

function safeFileToken(value, fallback = 'UNKNOWN') {
  const token = clean(value).replace(/[^A-Za-z0-9._-]+/g, '-');
  return token || fallback;
}

function execute(command, args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', maxBuffer },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function pickTicketDocument(documentId) {
  const { data, error } = await supabase
    .from('documents')
    .select('*')
    .eq('id', documentId)
    .in('source', [
      'a2000_pick_ticket_snapshot',
      'a2000_pick_ticket_observer'
    ])
    .single();

  if (error) throw error;
  return data;
}

async function orderById(orderId) {
  const { data, error } = await supabase
    .from('purchase_orders')
    .select('*, purchase_order_lines(*)')
    .eq('id', orderId)
    .single();

  if (error) throw error;
  return data;
}

async function updateChecklistAudit(document, values) {
  const raw = document.raw && typeof document.raw === 'object'
    ? document.raw
    : {};

  const { data, error } = await supabase
    .from('documents')
    .update({
      raw: {
        ...raw,
        ...values
      }
    })
    .eq('id', document.id)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

export async function generateChecklistForPickTicketDocument(
  documentId,
  { force = false } = {}
) {
  const document = await pickTicketDocument(documentId);
  const raw = document.raw || {};
  const inputPath = clean(raw.checklist_input_path);
  const purchaseOrderId = clean(raw.purchase_order_id);

  if (!inputPath || !purchaseOrderId) {
    return {
      ok: false,
      generated: false,
      reason: 'CHECKLIST_INPUT_NOT_READY',
      document_id: document.id
    };
  }

  if (
    !force
    && clean(raw.generated_checklist_path)
  ) {
    try {
      await fs.stat(raw.generated_checklist_path);
      return {
        ok: true,
        generated: false,
        idempotent: true,
        document_id: document.id,
        file_path: raw.generated_checklist_path,
        file_name: path.basename(raw.generated_checklist_path)
      };
    } catch {}
  }

  const [input, order] = await Promise.all([
    fs.readFile(inputPath, 'utf8').then(JSON.parse),
    orderById(purchaseOrderId)
  ]);

  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    return {
      ok: false,
      generated: false,
      reason: 'CHECKLIST_SOURCE_LINES_MISSING',
      document_id: document.id
    };
  }

  const resolution = await resolveChecklistTemplateDetailed({
    customerCode: input.customer_code || order.customer_code,
    registryPath: REGISTRY
  });
  const template = resolution.template;

  if (!resolution.ok || !template) {
    await updateChecklistAudit(document, {
      checklist_status: 'template_blocked',
      checklist_reason: resolution.reason,
      checklist_block_reason: resolution.block_reason || null
    });

    return {
      ok: false,
      generated: false,
      reason: resolution.reason
        || 'CHECKLIST_TEMPLATE_RESOLUTION_FAILED',
      block_reason: resolution.block_reason || null,
      customer_code: input.customer_code || order.customer_code,
      control_no: input.control_no,
      document_id: document.id
    };
  }

  const safeCustomer = safeFileToken(
    template.customer_code
    || input.customer_code
    || order.customer_code,
    'NO-CUSTOMER'
  );
  const safeControl = safeFileToken(input.control_no, 'NO-CONTROL');
  const extension = template.extension === '.xlsm'
    ? '.xlsm'
    : '.xlsx';
  const output = path.join(
    GENERATED_ROOT,
    safeCustomer,
    `CTRL-${safeControl}-CHECKLIST${extension}`
  );
  const tempOutput = path.join(
    GENERATED_ROOT,
    safeCustomer,
    `.CTRL-${safeControl}-CHECKLIST.tmp-${crypto.randomUUID()}${extension}`
  );
  const payloadPath = path.join(
    GENERATED_ROOT,
    '.payloads',
    `${crypto.randomUUID()}.json`
  );

  const payload = buildChecklistPayloadFromAuthoritativeInput({
    input,
    order,
    template
  });

  if (!payload.lines.length) {
    return {
      ok: false,
      generated: false,
      reason: 'CHECKLIST_SOURCE_LINES_MISSING',
      document_id: document.id
    };
  }

  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    payloadPath,
    JSON.stringify(payload, null, 2),
    'utf8'
  );

  try {
    const result = await execute('python3', [
      ENGINE,
      'generate',
      '--template',
      template.resolved_template_path || template.template_path,
      '--payload',
      payloadPath,
      '--output',
      tempOutput
    ]);
    const engine = JSON.parse(result.stdout.trim());
    const generationSafety = validateChecklistEngineResult(engine);

    if (!generationSafety.ok) {
      return {
        ok: false,
        generated: false,
        reason: generationSafety.reason,
        customer_code: input.customer_code,
        order_no: input.order_no,
        control_no: input.control_no,
        pick_ticket_no: input.pick_ticket_no,
        document_id: document.id,
        template,
        engine
      };
    }

    await fs.rename(tempOutput, output);
    await updateChecklistAudit(document, {
      checklist_status: 'generated',
      checklist_reason: null,
      generated_checklist_path: output,
      generated_checklist_file_name: path.basename(output),
      generated_checklist_at: new Date().toISOString(),
      generated_checklist_source_precedence: input.source_precedence,
      generated_checklist_conflict_count: input.conflict_count,
      generated_checklist_template_sha256: template.sha256
    });

    return {
      ok: true,
      generated: true,
      checklist_scope: 'ONE_CHECKLIST_PER_CONTROL',
      customer_code: input.customer_code,
      order_no: input.order_no,
      store_code: input.store_code,
      control_no: input.control_no,
      pick_ticket_no: input.pick_ticket_no,
      purchase_order_id: order.id,
      document_id: document.id,
      file_path: output,
      file_name: path.basename(output),
      template,
      engine
    };
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => null);
    await fs.rm(tempOutput, { force: true }).catch(() => null);
  }
}

export async function checklistPathForPickTicketDocument(documentId) {
  const document = await pickTicketDocument(documentId);
  const filePath = clean(document.raw?.generated_checklist_path);

  if (!filePath) return null;

  try {
    await fs.stat(filePath);
    return filePath;
  } catch {
    return null;
  }
}
