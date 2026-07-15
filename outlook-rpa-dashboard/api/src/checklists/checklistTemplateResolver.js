import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');
const CHECKLIST_ROOT = path.join(API_ROOT, 'checklists');
export const DEFAULT_CHECKLIST_REGISTRY_PATH = path.join(
  CHECKLIST_ROOT,
  'approved-template-registry.json'
);

function clean(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

export function normalizeChecklistCustomerToken(value) {
  return clean(value)
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function exists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function sha256(filePath) {
  const buffer = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export async function loadChecklistRegistry(
  registryPath = DEFAULT_CHECKLIST_REGISTRY_PATH
) {
  const raw = JSON.parse(await fs.readFile(registryPath, 'utf8'));
  const customers = raw?.customers;
  if (!customers || typeof customers !== 'object' || Array.isArray(customers)) {
    throw new Error('CHECKLIST_REGISTRY_INVALID_CUSTOMERS');
  }
  return raw;
}

export function buildChecklistAliasIndex(registry = {}) {
  const index = new Map();
  const collisions = [];

  for (const [customerCode, profile] of Object.entries(registry.customers || {})) {
    const canonical = clean(customerCode).toUpperCase();
    const values = [canonical, ...(Array.isArray(profile.aliases) ? profile.aliases : [])];

    for (const value of values) {
      const token = normalizeChecklistCustomerToken(value);
      if (!token) continue;
      const current = index.get(token);
      if (current && current !== canonical) {
        collisions.push({ token, current, incoming: canonical });
        continue;
      }
      index.set(token, canonical);
    }
  }

  return { index, collisions };
}

export function canonicalChecklistCustomerCode(customerCode, registry = {}) {
  const requested = normalizeChecklistCustomerToken(customerCode);
  if (!requested) return null;
  const { index } = buildChecklistAliasIndex(registry);
  return index.get(requested) || null;
}

function profileTemplatePath(profile, registryPath) {
  const configured = clean(profile?.bundled_template_path);
  if (!configured) return null;
  if (path.isAbsolute(configured)) return configured;
  return path.resolve(path.dirname(registryPath), configured);
}

export async function resolveChecklistTemplateDetailed({
  customerCode,
  registryPath = DEFAULT_CHECKLIST_REGISTRY_PATH,
  registry = null,
  verifyHash = true
} = {}) {
  const loadedRegistry = registry || await loadChecklistRegistry(registryPath);
  const canonicalCode = canonicalChecklistCustomerCode(customerCode, loadedRegistry);

  if (!canonicalCode) {
    return {
      ok: false,
      template: null,
      reason: 'CHECKLIST_CUSTOMER_NOT_REGISTERED',
      requested_customer_code: clean(customerCode) || null,
      canonical_customer_code: null,
      registry_version: loadedRegistry.version || null,
      runtime_policy: loadedRegistry.runtime_policy || null
    };
  }

  const profile = loadedRegistry.customers[canonicalCode];
  const status = clean(profile?.checklist_status).toLowerCase();

  if (!profile?.allow_generation || !['canonical', 'provisional'].includes(status)) {
    return {
      ok: false,
      template: null,
      reason: 'CHECKLIST_TEMPLATE_MISSING',
      requested_customer_code: clean(customerCode) || null,
      canonical_customer_code: canonicalCode,
      checklist_status: status || null,
      production_status: profile?.production_status || null,
      notes: profile?.notes || null,
      block_reason: profile?.block_reason || null,
      registry_version: loadedRegistry.version || null,
      runtime_policy: loadedRegistry.runtime_policy || null
    };
  }

  const templatePath = profileTemplatePath(profile, registryPath);
  if (!templatePath || !(await exists(templatePath))) {
    return {
      ok: false,
      template: null,
      reason: 'CHECKLIST_TEMPLATE_FILE_NOT_FOUND',
      requested_customer_code: clean(customerCode) || null,
      canonical_customer_code: canonicalCode,
      checklist_status: status,
      configured_template_path: profile?.bundled_template_path || null,
      resolved_template_path: templatePath,
      registry_version: loadedRegistry.version || null,
      runtime_policy: loadedRegistry.runtime_policy || null
    };
  }

  const actualSha256 = await sha256(templatePath);
  const expectedSha256 = clean(profile?.sha256).toLowerCase();
  if (verifyHash && expectedSha256 && actualSha256 !== expectedSha256) {
    return {
      ok: false,
      template: null,
      reason: 'CHECKLIST_TEMPLATE_HASH_MISMATCH',
      requested_customer_code: clean(customerCode) || null,
      canonical_customer_code: canonicalCode,
      checklist_status: status,
      resolved_template_path: templatePath,
      expected_sha256: expectedSha256,
      actual_sha256: actualSha256,
      registry_version: loadedRegistry.version || null,
      runtime_policy: loadedRegistry.runtime_policy || null
    };
  }

  const extension = path.extname(templatePath).toLowerCase();
  const warning = status === 'provisional'
    ? 'PROVISIONAL_CUSTOMER_CHECKLIST_TEMPLATE'
    : null;

  return {
    ok: true,
    reason: null,
    requested_customer_code: clean(customerCode) || null,
    canonical_customer_code: canonicalCode,
    checklist_status: status,
    production_status: profile?.production_status || null,
    warning,
    registry_version: loadedRegistry.version || null,
    runtime_policy: loadedRegistry.runtime_policy || null,
    template: {
      customer_code: canonicalCode,
      customer_codes: [canonicalCode],
      template_id: actualSha256.slice(0, 16),
      source: profile?.source_path || profile?.bundled_template_path || null,
      source_tier: profile?.source_tier || null,
      template_path: templatePath,
      resolved_template_path: templatePath,
      bundled_template_path: profile?.bundled_template_path || null,
      extension,
      sha256: actualSha256,
      expected_sha256: expectedSha256 || null,
      checklist_status: status,
      production_status: profile?.production_status || null,
      notes: profile?.notes || null,
      block_reason: profile?.block_reason || null,
      schema: profile?.schema || null,
      resolution_mode: 'STRICT_CANONICAL_REGISTRY',
      runtime_policy: loadedRegistry.runtime_policy || null,
      registry_version: loadedRegistry.version || null
    }
  };
}

// Compatibility wrapper for older callers. Historical catalog arguments are
// intentionally ignored: runtime selection is registry-only.
export async function resolveChecklistTemplate(options = {}) {
  const result = await resolveChecklistTemplateDetailed(options);
  return result.ok ? result.template : null;
}
