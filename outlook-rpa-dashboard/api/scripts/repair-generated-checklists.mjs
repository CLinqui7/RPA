import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { supabase } from '../src/supabase.js';
import { generateChecklistForOrder } from '../src/checklists/checklistService.js';
import {
  canonicalChecklistCustomerCode,
  loadChecklistRegistry,
  DEFAULT_CHECKLIST_REGISTRY_PATH
} from '../src/checklists/checklistTemplateResolver.js';
import {
  buildChecklistRepairCandidate,
  checklistRepairGroupSafety,
  selectChecklistRepairGroups
} from '../src/checklists/checklistRepairSelection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const GENERATED_ROOT = path.join(API_ROOT, 'generated', 'checklists');
const BACKUP_ROOT = path.join(API_ROOT, 'backups');

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function latestA2000JobsByOrderId(orderIds) {
  if (!orderIds.length) return new Map();

  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('purchase_order_id,a2000_ctrl_no,a2000_seq_order_no,status,updated_at')
    .in('purchase_order_id', orderIds)
    .order('updated_at', { ascending: false });

  if (error) throw error;

  const latest = new Map();
  for (const job of data || []) {
    const id = clean(job.purchase_order_id);
    if (!id || latest.has(id)) continue;
    latest.set(id, job);
  }
  return latest;
}

async function removeObsoletePendingChecklistFiles(customerCode, keepPaths = []) {
  const customerDir = path.join(GENERATED_ROOT, customerCode);
  const keep = new Set(keepPaths.map(filePath => path.resolve(filePath)));
  const removed = [];
  const entries = await fs.readdir(customerDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^CTRL-PENDING-.*-CHECKLIST\.(xlsx|xlsm)$/i.test(entry.name)) continue;
    const filePath = path.join(customerDir, entry.name);
    if (keep.has(path.resolve(filePath))) continue;
    await fs.rm(filePath, { force: true });
    removed.push(filePath);
  }

  return removed;
}

const apply = hasFlag('--apply');
const all = hasFlag('--all');
const replacePending = hasFlag('--replace-pending');
const requestedCustomer = argValue('--customer');
const orderId = argValue('--order-id');
const limit = Math.max(1, Math.min(Number(argValue('--limit') || 1000), 5000));

if (!all && !requestedCustomer && !orderId) {
  console.error('Choose one scope: --customer CODE, --order-id ID, or --all.');
  console.error('The command is dry-run unless --apply is supplied.');
  process.exit(2);
}

if (replacePending && orderId) {
  console.error('--replace-pending cannot be used with --order-id.');
  console.error('Use it with --customer CODE or --all after reviewing the dry-run.');
  process.exit(2);
}

const registry = await loadChecklistRegistry(DEFAULT_CHECKLIST_REGISTRY_PATH);
const canonicalCustomer = requestedCustomer
  ? canonicalChecklistCustomerCode(requestedCustomer, registry)
  : null;

if (requestedCustomer && !canonicalCustomer) {
  console.error(`Customer not registered for checklists: ${requestedCustomer}`);
  process.exit(2);
}

let query = supabase
  .from('purchase_orders')
  .select(`
    id,
    customer_code,
    order_no,
    store_code,
    order_instance_key,
    status,
    created_at,
    raw_json,
    purchase_order_lines(id)
  `)
  .order('created_at', { ascending: false })
  .limit(limit);

if (orderId) query = query.eq('id', orderId);
if (canonicalCustomer) {
  const aliases = registry.customers[canonicalCustomer]?.aliases || [canonicalCustomer];
  query = query.in('customer_code', [...new Set([canonicalCustomer, ...aliases])]);
}

const { data: orders, error } = await query;
if (error) throw error;

const selected = orders || [];
const jobsByOrderId = await latestA2000JobsByOrderId(selected.map(order => order.id));
const candidates = selected.map(order => {
  const canonicalCustomerCode = canonicalChecklistCustomerCode(order.customer_code, registry)
    || clean(order.customer_code).toUpperCase()
    || 'NO-CUSTOMER';
  return buildChecklistRepairCandidate({
    order,
    canonicalCustomerCode,
    job: jobsByOrderId.get(clean(order.id)) || null
  });
});
const controlGroups = selectChecklistRepairGroups(candidates);
const duplicateOrderCount = controlGroups.reduce(
  (total, group) => total + group.duplicates.length,
  0
);
const unsafeGroups = controlGroups
  .map(group => ({ group, safety: checklistRepairGroupSafety(group) }))
  .filter(item => !item.safety.ok);

const dryRunPayload = {
  mode: apply ? 'APPLY' : 'DRY_RUN',
  scope: orderId
    ? { order_id: orderId }
    : canonicalCustomer
      ? { customer_code: canonicalCustomer }
      : { all: true },
  source_order_count: selected.length,
  unique_control_count: controlGroups.length,
  duplicate_order_count: duplicateOrderCount,
  unsafe_control_count: unsafeGroups.length,
  replace_pending_requested: replacePending,
  controls: controlGroups.map(group => {
    const safety = checklistRepairGroupSafety(group);
    return {
      group_key: group.group_key,
      canonical_customer_code: group.representative.canonical_customer_code,
      internal_control_key: group.representative.internal_control_key,
      representative_order_id: group.representative.order.id,
      representative_order_no: group.representative.order.order_no,
      representative_store_code: group.representative.order.store_code,
      representative_line_count: group.representative.source_line_count,
      total_source_line_count: group.total_source_line_count,
      actual_control_no: group.actual_control_no,
      actual_control_source_order_id: group.actual_control_source_order_id,
      conflicting_actual_controls: group.conflicting_actual_controls,
      provisional_control_no: group.representative.provisional_control_no,
      safety_status: safety.ok ? 'SAFE' : 'BLOCKED',
      safety_reason: safety.reason,
      duplicate_orders_skipped: group.duplicates.map(item => ({
        purchase_order_id: item.order.id,
        line_count: item.source_line_count,
        actual_control_no: item.actual_control_no
      }))
    };
  })
};

console.log(JSON.stringify(dryRunPayload, null, 2));

if (!apply) {
  console.log('\nDry-run only.');
  console.log('The repair chooses the data-rich purchase_order row and preserves an A2000 control found on any duplicate row.');
  console.log('No workbook with zero source lines is allowed to replace an existing checklist.');
  console.log('To regenerate and then remove obsolete pending files, add: --apply --replace-pending');
  process.exit(0);
}

if (unsafeGroups.length > 0) {
  console.error('\nAPPLY BLOCKED: one or more controls are unsafe.');
  console.error('Resolve missing source lines or conflicting A2000 controls before generating checklists.');
  process.exit(3);
}

let backupDir = null;
try {
  const generatedExists = await fs.stat(GENERATED_ROOT)
    .then(stat => stat.isDirectory())
    .catch(() => false);
  if (generatedExists) {
    backupDir = path.join(BACKUP_ROOT, `generated-checklists-before-v5-2-${timestamp()}`);
    await fs.mkdir(path.dirname(backupDir), { recursive: true });
    await fs.cp(GENERATED_ROOT, backupDir, { recursive: true });
    console.error(`Backup created: ${backupDir}`);
  }

  const results = [];
  for (const group of controlGroups) {
    const selectedControl = group.representative;
    const order = selectedControl.order;
    try {
      const result = await generateChecklistForOrder(order.id, {
        controlNoOverride: group.actual_control_no
      });
      results.push({
        group_key: group.group_key,
        purchase_order_id: order.id,
        customer_code: order.customer_code,
        order_no: order.order_no,
        representative_line_count: selectedControl.source_line_count,
        actual_control_source_order_id: group.actual_control_source_order_id,
        duplicate_order_ids_skipped: group.duplicates.map(item => item.order.id),
        ...result
      });
      console.error(
        `${order.customer_code} ${order.order_no || order.id}: `
        + `${result.generated ? `GENERATED ${result.engine?.line_count || 0} lines` : result.reason}`
      );
    } catch (generationError) {
      results.push({
        group_key: group.group_key,
        purchase_order_id: order.id,
        customer_code: order.customer_code,
        order_no: order.order_no,
        representative_line_count: selectedControl.source_line_count,
        ok: false,
        generated: false,
        reason: 'CHECKLIST_REGENERATION_EXCEPTION',
        error: generationError.message
      });
      console.error(`${order.customer_code} ${order.order_no || order.id}: ERROR ${generationError.message}`);
    }
  }

  let removedPendingFiles = [];
  if (replacePending) {
    const groupsByCustomer = new Map();
    for (const group of controlGroups) {
      const code = group.representative.canonical_customer_code;
      if (!groupsByCustomer.has(code)) groupsByCustomer.set(code, []);
      groupsByCustomer.get(code).push(group);
    }

    for (const [customerCode, customerGroups] of groupsByCustomer.entries()) {
      const groupKeys = new Set(customerGroups.map(group => group.group_key));
      const customerResults = results.filter(result => groupKeys.has(result.group_key));
      const allGeneratedSafely = customerResults.length === customerGroups.length
        && customerResults.every(result => result.generated && Number(result.engine?.line_count || 0) > 0);

      if (!allGeneratedSafely) {
        console.error(`Pending cleanup skipped for ${customerCode}: not every control generated a non-empty workbook.`);
        continue;
      }

      const keepPaths = customerResults
        .map(result => result.file_path)
        .filter(Boolean);
      const removed = await removeObsoletePendingChecklistFiles(customerCode, keepPaths);
      removedPendingFiles.push(...removed);
      console.error(`Obsolete pending checklist files removed for ${customerCode}: ${removed.length}`);
    }
  }

  const summary = {
    ok: results.every(item => item.generated || item.reason === 'CHECKLIST_TEMPLATE_MISSING'),
    backup_dir: backupDir,
    source_order_count: selected.length,
    unique_control_count: controlGroups.length,
    duplicate_order_count: duplicateOrderCount,
    duplicate_order_ids_skipped: controlGroups.flatMap(
      group => group.duplicates.map(item => item.order.id)
    ),
    removed_pending_file_count: removedPendingFiles.length,
    removed_pending_files: removedPendingFiles,
    generated_count: results.filter(item => item.generated).length,
    blocked_count: results.filter(
      item => !item.generated && item.reason === 'CHECKLIST_TEMPLATE_MISSING'
    ).length,
    failed_count: results.filter(
      item => !item.generated && item.reason !== 'CHECKLIST_TEMPLATE_MISSING'
    ).length,
    empty_output_blocked_count: results.filter(
      item => item.reason === 'CHECKLIST_EMPTY_OUTPUT'
    ).length,
    results
  };

  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed_count > 0) process.exitCode = 1;
} catch (repairError) {
  console.error(repairError.stack || repairError.message);
  process.exitCode = 1;
}
