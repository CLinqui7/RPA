import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { supabase } from '../supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = path.resolve(API_ROOT, '..');
const RPA_ROOT = path.resolve(PROJECT_ROOT, '..');
const ENGINE = path.join(API_ROOT, 'scripts', 'checklist_template_engine.py');
const CATALOG = path.join(API_ROOT, 'checklists', 'catalog.json');
const TEMPLATE_EXTRACT = path.join(API_ROOT, 'checklists', 'templates');
const GENERATED_ROOT = path.join(API_ROOT, 'generated', 'checklists');

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

  return {
    ...catalog,
    roots,
    recognized_customer_codes: [
      ...new Set(
        (catalog.templates || [])
          .map(item => item.customer_code)
          .filter(Boolean)
      )
    ].sort()
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

function qtyBuckets(line = {}) {
  const output = {};
  for (let index = 1; index <= 18; index += 1) {
    const value = Number(line[`qty_sz${index}`] || 0);
    if (Number.isFinite(value) && value > 0) output[`QTY_SZ${index}`] = value;
  }
  return output;
}

function checklistPayload(order) {
  return {
    header: {
      customer_code: order.customer_code,
      order_no: order.order_no,
      order_date: order.order_date,
      start_date: order.start_date,
      cancel_date: order.cancel_date,
      store_code: order.store_code,
      division_code: order.division_code,
      terms_code: order.terms_code,
      warehouse_code: order.warehouse_code
    },
    lines: (order.purchase_order_lines || []).map(line => ({
      style_code: line.style_code,
      color_code: line.color_code,
      customer_style: line.style_raw,
      customer_color: line.color_raw,
      customer_sku: line.customer_sku,
      customer_upc: line.raw_json?.customer_upc_raw || line.raw_json?.customer_upc || line.ticket_sku,
      qty_total: line.qty_total,
      size_raw: line.size_raw,
      sales_price: line.sales_price,
      description: line.description,
      order_no: order.order_no,
      store_code: order.store_code,
      division_code: order.division_code,
      terms_code: order.terms_code,
      warehouse_code: line.warehouse_code || order.warehouse_code,
      qty_buckets: qtyBuckets(line)
    }))
  };
}

function chooseTemplate(catalog, customerCode) {
  const code = clean(customerCode).toUpperCase();
  const candidates = (catalog.templates || []).filter(item => (
    !item.error && clean(item.customer_code).toUpperCase() === code && item.best_sheet?.table
  ));
  return candidates.sort((left, right) => (
    Number(right.best_sheet?.table?.score || 0) - Number(left.best_sheet?.table?.score || 0)
    || Number(right.image_count || 0) - Number(left.image_count || 0)
    || Number(right.size_bytes || 0) - Number(left.size_bytes || 0)
  ))[0] || null;
}

export async function generateChecklistForOrder(orderId, { rebuildCatalog = false } = {}) {
  const order = await orderById(orderId);
  const catalog = rebuildCatalog ? await rebuildChecklistCatalog() : await checklistCatalog();
  const template = chooseTemplate(catalog, order.customer_code);
  if (!template) {
    return {
      ok: false,
      generated: false,
      reason: 'NO_CUSTOMER_CHECKLIST_TEMPLATE',
      customer_code: order.customer_code,
      order_no: order.order_no,
      template_count: catalog.template_count || 0
    };
  }

  const safeCustomer = clean(order.customer_code).replace(/[^A-Za-z0-9_-]+/g, '-');
  const safeOrder = clean(order.order_no).replace(/[^A-Za-z0-9._-]+/g, '-');
  const extension = template.extension === '.xlsm' ? '.xlsm' : '.xlsx';
  const output = path.join(GENERATED_ROOT, safeCustomer, `${safeOrder}-CHECKLIST${extension}`);
  const payloadPath = path.join(GENERATED_ROOT, '.payloads', `${crypto.randomUUID()}.json`);
  await fs.mkdir(path.dirname(payloadPath), { recursive: true });
  await fs.writeFile(payloadPath, JSON.stringify(checklistPayload(order), null, 2));

  try {
    const result = await execute('python3', [
      ENGINE,
      'generate',
      '--template', template.template_path,
      '--payload', payloadPath,
      '--output', output
    ]);
    return {
      ok: true,
      generated: true,
      customer_code: order.customer_code,
      order_no: order.order_no,
      purchase_order_id: order.id,
      file_path: output,
      file_name: path.basename(output),
      template,
      engine: JSON.parse(result.stdout.trim())
    };
  } finally {
    await fs.rm(payloadPath, { force: true }).catch(() => null);
  }
}

export async function checklistDownloadPath(orderId) {
  const order = await orderById(orderId);
  const safeCustomer = clean(order.customer_code).replace(/[^A-Za-z0-9_-]+/g, '-');
  const safeOrder = clean(order.order_no).replace(/[^A-Za-z0-9._-]+/g, '-');
  for (const extension of ['.xlsx', '.xlsm']) {
    const candidate = path.join(GENERATED_ROOT, safeCustomer, `${safeOrder}-CHECKLIST${extension}`);
    if (await exists(candidate)) return candidate;
  }
  return null;
}
