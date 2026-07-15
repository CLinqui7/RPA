import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from '../supabase.js';
import {
  DEFAULT_CHECKLIST_REGISTRY_PATH,
  loadChecklistRegistry,
  resolveChecklistTemplateDetailed
} from './checklistTemplateResolver.js';
import {
  checklistInternalControlKey,
  provisionalChecklistControlNo
} from './checklistControlIdentity.js';
import { validateChecklistEngineResult } from './checklistGenerationSafety.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');
const RPA_ROOT = path.resolve(PROJECT_ROOT, '..');
const ENGINE = path.join(API_ROOT, 'scripts', 'checklist_template_engine.py');
const CATALOG = path.join(API_ROOT, 'checklists', 'catalog.json');
const TEMPLATE_EXTRACT = path.join(API_ROOT, 'checklists', 'templates');
const GENERATED_ROOT = path.join(API_ROOT, 'generated', 'checklists');
const REGISTRY = DEFAULT_CHECKLIST_REGISTRY_PATH;

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function execute(command, args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(filePath) {
  try { await fs.stat(filePath); return true; } catch { return false; }
}

export async function historicalChecklistRoots() {
  const explicit = clean(process.env.A2000_HISTORICAL_ROOT)
    .split(path.delimiter)
    .map(item => item.trim())
    .filter(Boolean);
  const candidates = [
    ...explicit,
    path.join(RPA_ROOT, 'Hermanito'),
    path.join(RPA_ROOT, 'historicos'),
    path.join(RPA_ROOT, 'Históricos'),
    path.join(RPA_ROOT, 'Chaty'),
    path.join(PROJECT_ROOT, 'Hermanito'),
    path.join(API_ROOT, 'training', 'historical'),
    path.join(API_ROOT, 'training', 'historical', 'Customers_Master_Checklists')
  ];

  for (const entry of await fs.readdir(RPA_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.zip$/i.test(entry.name)) continue;
    if (/hermanito|histor|chaty|customer|master|checklist/i.test(entry.name)) candidates.push(path.join(RPA_ROOT, entry.name));
  }

  const found = [];
  for (const candidate of [...new Set(candidates)]) {
    if (await exists(candidate)) found.push(candidate);
  }
  return found;
}

export async function rebuildChecklistCatalog() {
  const roots = await historicalChecklistRoots();
  await fs.mkdir(path.dirname(CATALOG), { recursive: true });
  await fs.mkdir(TEMPLATE_EXTRACT, { recursive: true });
  const args = [ENGINE, 'catalog', '--extract-dir', TEMPLATE_EXTRACT, '--output', CATALOG];
  for (const root of roots) args.push('--root', root);
  await execute('python3', args);
  const catalog = JSON.parse(await fs.readFile(CATALOG, 'utf8'));
  return { ...catalog, roots };
}

export async function checklistCatalog() {
  const roots = await historicalChecklistRoots();
  if (!(await exists(CATALOG))) return rebuildChecklistCatalog();

  const catalog = JSON.parse(await fs.readFile(CATALOG, 'utf8'));
  if (Number(catalog.template_count || 0) === 0 && roots.length > 0) {
    return rebuildChecklistCatalog();
  }

  const registry = await loadChecklistRegistry(REGISTRY);
  const canonicalCustomers = Object.entries(registry.customers || {}).map(
    ([customerCode, profile]) => ({
      customer_code: customerCode,
      checklist_status: profile.checklist_status || null,
      allow_generation: Boolean(profile.allow_generation),
      production_status: profile.production_status || null,
      bundled_template_path: profile.bundled_template_path || null,
      sha256: profile.sha256 || null,
      source_path: profile.source_path || null,
      source_tier: profile.source_tier || null,
      notes: profile.notes || null,
      block_reason: profile.block_reason || null
    })
  );

  return {
    ...catalog,
    roots,
    runtime_policy: registry.runtime_policy || null,
    registry_version: registry.version || null,
    canonical_customers: canonicalCustomers,
    canonical_template_count: canonicalCustomers.filter(item => item.allow_generation).length,
    missing_canonical_template_count: canonicalCustomers.filter(item => !item.allow_generation).length,
    recognized_customer_codes: canonicalCustomers
      .map(item => item.customer_code)
      .sort()
  };
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

async function a2000ControlForOrder(orderId) {
  const { data, error } = await supabase
    .from('a2000_rest_jobs')
    .select('a2000_ctrl_no,a2000_seq_order_no,status,updated_at')
    .eq('purchase_order_id', String(orderId))
    .not('a2000_ctrl_no', 'is', null)
    .order('updated_at', { ascending: false })
    .limit(1);

  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : null;
  const controlNo = clean(row?.a2000_ctrl_no || row?.a2000_seq_order_no);

  return {
    control_no: controlNo || null,
    status: clean(row?.status) || null,
    actual: Boolean(controlNo)
  };
}

function safeFileToken(value, fallback = 'UNKNOWN') {
  const token = clean(value).replace(/[^A-Za-z0-9._-]+/g, '-');
  return token || fallback;
}


async function checklistControlIdentity(order, { controlNoOverride = null } = {}) {
  const actual = await a2000ControlForOrder(order.id);
  const override = clean(controlNoOverride);
  const effectiveActualControl = override || actual.control_no;
  const controlNo = effectiveActualControl || provisionalChecklistControlNo(order);

  return {
    control_no: controlNo,
    actual_control_no: effectiveActualControl || null,
    control_status: effectiveActualControl ? 'A2000_ASSIGNED' : 'PENDING_A2000',
    a2000_job_status: override ? 'REPAIR_GROUP_CONTROL_OVERRIDE' : actual.status,
    internal_control_key: checklistInternalControlKey(order),
    file_stem: `CTRL-${safeFileToken(controlNo)}`
  };
}

function qtyBuckets(line = {}) {
  const output = {};
  for (let index = 1; index <= 18; index += 1) {
    const value = Number(line[`qty_sz${index}`] || 0);
    if (Number.isFinite(value) && value > 0) output[`QTY_SZ${index}`] = value;
  }
  return output;
}

function firstValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    return value;
  }
  return null;
}

function rawValue(raw = {}, ...keys) {
  const sources = [raw, raw?.raw, raw?.metadata, raw?.source];
  for (const key of keys) {
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;
      const value = source[key];
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && !value.trim()) continue;
      return value;
    }
  }
  return null;
}

function checklistPayload(order, identity, template) {
  const orderRaw = order.raw_json?.header?.raw || order.raw_json?.header || {};
  const header = {
    control_no: identity.control_no,
    a2000_control_no: identity.actual_control_no,
    control_status: identity.control_status,
    internal_control_key: identity.internal_control_key,
    purchase_order_id: order.id,
    customer_code: order.customer_code,
    order_no: order.order_no,
    order_date: order.order_date,
    start_date: order.start_date,
    cancel_date: order.cancel_date,
    store_code: order.store_code,
    division_code: order.division_code,
    terms_code: order.terms_code,
    warehouse_code: order.warehouse_code,
    dept_code: firstValue(order.dept_code, order.dept_raw),
    ship_via: firstValue(order.ship_via_code, rawValue(orderRaw, 'ship_via_raw', 'ship_via')),
    pick_ticket_no: rawValue(orderRaw, 'pick_ticket_no', 'pick_ticket_raw', 'picktkt', 'pt_no'),
    tickets: rawValue(orderRaw, 'tickets_raw', 'ticketing_raw', 'preticket_raw'),
    tracking: rawValue(orderRaw, 'tracking_raw', 'tracking_no_raw', 'tracking_number_raw'),
    dc_name: rawValue(orderRaw, 'dc_name_raw', 'store_name_raw', 'ship_to_name_raw')
  };

  const lines = (order.purchase_order_lines || []).map(line => {
    const raw = line.raw_json || {};
    const buckets = qtyBuckets(line);
    const customerUpc = firstValue(
      rawValue(raw, 'customer_upc_raw', 'customer_upc', 'upc_raw', 'upc'),
      line.ticket_sku
    );
    const customerSku = firstValue(
      line.customer_sku,
      rawValue(raw, 'customer_sku_raw', 'customer_sku', 'sku_raw')
    );

    const output = {
      control_no: identity.control_no,
      customer_code: order.customer_code,
      style_code: line.style_code,
      color_code: line.color_code,
      customer_style: firstValue(line.style_raw, rawValue(raw, 'customer_style_raw', 'vendor_style_raw')),
      manufacturer_style: rawValue(raw, 'manufacturer_style_raw', 'mfg_style_raw', 'vendor_style_raw'),
      customer_color: firstValue(line.color_raw, rawValue(raw, 'customer_color_raw', 'mfg_color_raw')),
      customer_sku: customerSku,
      customer_upc: customerUpc,
      customer_sku_upc: firstValue(customerSku, customerUpc),
      qty_total: line.qty_total,
      size_raw: line.size_raw,
      sales_price: line.sales_price,
      retail_price: firstValue(line.list_price, rawValue(raw, 'retail_price_raw', 'retail_price', 'list_price_raw')),
      description: line.description,
      order_no: order.order_no,
      order_date: order.order_date,
      start_date: order.start_date,
      cancel_date: order.cancel_date,
      store_code: order.store_code,
      division_code: order.division_code,
      terms_code: order.terms_code,
      warehouse_code: firstValue(line.warehouse_code, order.warehouse_code),
      line_warehouse_code: line.warehouse_code,
      dept_code: firstValue(order.dept_code, order.dept_raw, rawValue(raw, 'dept_code', 'dept_raw')),
      pick_ticket_no: firstValue(
        rawValue(raw, 'pick_ticket_no', 'pick_ticket_raw', 'picktkt', 'pt_no', 'pt_raw'),
        header.pick_ticket_no
      ),
      cartons: rawValue(raw, 'cartons_raw', 'carton_count_raw', 'carton_qty_raw', 'cartons'),
      carton_id: rawValue(raw, 'carton_id_raw', 'carton_id', 'carton_identifier_raw'),
      tickets: firstValue(rawValue(raw, 'tickets_raw', 'ticketing_raw', 'preticket_raw'), header.tickets),
      tracking: firstValue(rawValue(raw, 'tracking_raw', 'tracking_no_raw', 'tracking_number_raw'), header.tracking),
      sub_sku: rawValue(raw, 'sub_sku_raw', 'sub_sku', 'substitution_sku_raw'),
      sub_style: rawValue(raw, 'sub_style_raw', 'sub_style', 'substitution_style_raw'),
      sub_color: rawValue(raw, 'sub_color_raw', 'sub_color', 'substitution_color_raw'),
      dc_name: firstValue(rawValue(raw, 'dc_name_raw', 'store_name_raw'), header.dc_name),
      packing_instructions: rawValue(raw, 'packing_instructions_raw', 'packing_instructions', 'pack_instructions_raw'),
      pln_no: rawValue(raw, 'pln_no_raw', 'pln_raw', 'pln_no'),
      qty_buckets: buckets
    };

    for (let index = 1; index <= 18; index += 1) {
      output[`qty_sz${index}`] = buckets[`QTY_SZ${index}`] || null;
    }
    return output;
  });

  return {
    header,
    lines,
    template_profile: {
      customer_code: template.customer_code,
      checklist_status: template.checklist_status,
      production_status: template.production_status,
      schema: template.schema,
      sha256: template.sha256,
      resolution_mode: template.resolution_mode,
      registry_version: template.registry_version,
      runtime_policy: template.runtime_policy
    }
  };
}

export async function generateChecklistForOrder(
  orderId,
  { rebuildCatalog = false, controlNoOverride = null } = {}
) {
  const order = await orderById(orderId);
  const identity = await checklistControlIdentity(order, { controlNoOverride });

  // Historical catalog rebuilding remains available for audit only. It never
  // participates in runtime template selection.
  if (rebuildCatalog) await rebuildChecklistCatalog();

  const resolution = await resolveChecklistTemplateDetailed({
    customerCode: order.customer_code,
    registryPath: REGISTRY
  });
  const template = resolution.template;

  if (!resolution.ok || !template) {
    return {
      ok: false,
      generated: false,
      reason: resolution.reason || 'CHECKLIST_TEMPLATE_RESOLUTION_FAILED',
      customer_code: order.customer_code,
      canonical_customer_code: resolution.canonical_customer_code || null,
      order_no: order.order_no,
      control_no: identity.control_no,
      control_status: identity.control_status,
      checklist_status: resolution.checklist_status || null,
      production_status: resolution.production_status || null,
      notes: resolution.notes || null,
      block_reason: resolution.block_reason || null,
      registry_version: resolution.registry_version || null,
      runtime_policy: resolution.runtime_policy || null
    };
  }

  const safeCustomer = safeFileToken(template.customer_code || order.customer_code, 'NO-CUSTOMER');
  const extension = template.extension === '.xlsm' ? '.xlsm' : '.xlsx';
  const output = path.join(GENERATED_ROOT, safeCustomer, `${identity.file_stem}-CHECKLIST${extension}`);
  const tempOutput = path.join(
    GENERATED_ROOT,
    safeCustomer,
    `.${identity.file_stem}-CHECKLIST.tmp-${crypto.randomUUID()}${extension}`
  );
  const payloadPath = path.join(GENERATED_ROOT, '.payloads', `${crypto.randomUUID()}.json`);

  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    payloadPath,
    JSON.stringify(checklistPayload(order, identity, template), null, 2)
  );

  try {
    const result = await execute('python3', [
      ENGINE,
      'generate',
      '--template', template.resolved_template_path || template.template_path,
      '--payload', payloadPath,
      '--output', tempOutput
    ]);
    const engine = JSON.parse(result.stdout.trim());
    const generationSafety = validateChecklistEngineResult(engine);

    if (!generationSafety.ok) {
      await fs.rm(tempOutput, { force: true }).catch(() => null);
      return {
        ok: false,
        generated: false,
        reason: generationSafety.reason,
        customer_code: order.customer_code,
        canonical_customer_code: template.customer_code,
        order_no: order.order_no,
        store_code: order.store_code,
        control_no: identity.control_no,
        actual_control_no: identity.actual_control_no,
        control_status: identity.control_status,
        internal_control_key: identity.internal_control_key,
        purchase_order_id: order.id,
        intended_file_path: output,
        template,
        engine
      };
    }

    await fs.rename(tempOutput, output);

    return {
      ok: true,
      generated: true,
      checklist_scope: 'ONE_CHECKLIST_PER_CONTROL',
      customer_code: order.customer_code,
      canonical_customer_code: template.customer_code,
      order_no: order.order_no,
      store_code: order.store_code,
      control_no: identity.control_no,
      actual_control_no: identity.actual_control_no,
      control_status: identity.control_status,
      internal_control_key: identity.internal_control_key,
      purchase_order_id: order.id,
      file_path: output,
      file_name: path.basename(output),
      template,
      template_warning: resolution.warning || null,
      registry_version: resolution.registry_version || null,
      runtime_policy: resolution.runtime_policy || null,
      engine
    };
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => null);
    await fs.rm(tempOutput, { force: true }).catch(() => null);
  }
}

export async function checklistDownloadPath(orderId) {
  const order = await orderById(orderId);
  const identity = await checklistControlIdentity(order);
  const resolution = await resolveChecklistTemplateDetailed({
    customerCode: order.customer_code,
    registryPath: REGISTRY
  });
  const canonicalCustomer = resolution.canonical_customer_code || order.customer_code;
  const safeCustomer = safeFileToken(canonicalCustomer, 'NO-CUSTOMER');
  const baseDir = path.join(GENERATED_ROOT, safeCustomer);
  const extensions = ['.xlsx', '.xlsm'];

  if (identity.actual_control_no) {
    for (const extension of extensions) {
      const actualPath = path.join(baseDir, `CTRL-${safeFileToken(identity.actual_control_no)}-CHECKLIST${extension}`);
      if (await exists(actualPath)) return actualPath;
    }

    const provisional = provisionalChecklistControlNo(order);
    for (const extension of extensions) {
      const provisionalPath = path.join(baseDir, `CTRL-${safeFileToken(provisional)}-CHECKLIST${extension}`);
      const actualPath = path.join(baseDir, `CTRL-${safeFileToken(identity.actual_control_no)}-CHECKLIST${extension}`);
      if (await exists(provisionalPath)) {
        await fs.rename(provisionalPath, actualPath);
        return actualPath;
      }
    }
  }

  for (const extension of extensions) {
    const current = path.join(baseDir, `${identity.file_stem}-CHECKLIST${extension}`);
    if (await exists(current)) return current;
  }

  const safeOrder = safeFileToken(order.order_no, 'NO-PO');
  const safeStore = safeFileToken(order.store_code || order.store_raw, 'NO-STORE');
  for (const extension of extensions) {
    const legacyStore = path.join(baseDir, `${safeOrder}-${safeStore}-CHECKLIST${extension}`);
    if (await exists(legacyStore)) return legacyStore;
    const legacyPo = path.join(baseDir, `${safeOrder}-CHECKLIST${extension}`);
    if (await exists(legacyPo)) return legacyPo;
  }

  return null;
}
