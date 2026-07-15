import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildChecklistAliasIndex,
  canonicalChecklistCustomerCode,
  loadChecklistRegistry,
  resolveChecklistTemplateDetailed
} from '../../src/checklists/checklistTemplateResolver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '../..');
const REGISTRY_PATH = path.join(API_ROOT, 'checklists', 'approved-template-registry.json');

test('registry has one runtime template at most per customer and no alias collisions', async () => {
  const registry = await loadChecklistRegistry(REGISTRY_PATH);
  assert.equal(registry.runtime_policy, 'ONE_CHECKLIST_PER_CUSTOMER_NO_RUNTIME_SCORING');
  assert.equal(Object.keys(registry.customers).length, 23);

  const { collisions } = buildChecklistAliasIndex(registry);
  assert.deepEqual(collisions, []);

  for (const [customerCode, profile] of Object.entries(registry.customers)) {
    if (profile.allow_generation) {
      assert.ok(['canonical', 'provisional'].includes(profile.checklist_status), customerCode);
      assert.match(profile.bundled_template_path, new RegExp(`canonical/${customerCode}/CHECKLIST\\.xlsx$`));
      assert.match(profile.sha256, /^[a-f0-9]{64}$/);
      assert.ok(profile.schema?.sheet_name, customerCode);
      assert.ok(profile.schema?.header_row > 0, customerCode);
      assert.ok(Object.keys(profile.schema?.columns || {}).length >= 3, customerCode);
    } else {
      assert.equal(profile.bundled_template_path, null, customerCode);
    }
  }
});

test('aliases normalize to the intended canonical customer', async () => {
  const registry = await loadChecklistRegistry(REGISTRY_PATH);
  const cases = {
    '10 Spot': '10BELOW',
    'Simply 10': '10BELOW',
    'Bealls': 'BEALLSOUTL',
    'CATCO': 'CATO',
    'Gabes': 'GABRIELBRO',
    'MarshaEcom': 'MARSHALLS',
    'TJXECOM': 'TJMAXX',
    "Macy's Backstage": 'MACYSBACKS',
    'Shoe Show': 'SHOE4500'
  };

  for (const [alias, expected] of Object.entries(cases)) {
    assert.equal(canonicalChecklistCustomerCode(alias, registry), expected, alias);
  }
});

test('every approved template resolves by exact bundled path and exact hash', async () => {
  const registry = await loadChecklistRegistry(REGISTRY_PATH);
  let approvedCount = 0;

  for (const [customerCode, profile] of Object.entries(registry.customers)) {
    const result = await resolveChecklistTemplateDetailed({
      customerCode,
      registry,
      registryPath: REGISTRY_PATH
    });

    if (!profile.allow_generation) {
      assert.equal(result.ok, false, customerCode);
      assert.equal(result.reason, 'CHECKLIST_TEMPLATE_MISSING', customerCode);
      continue;
    }

    approvedCount += 1;
    assert.equal(result.ok, true, customerCode);
    assert.equal(result.canonical_customer_code, customerCode);
    assert.equal(result.template.resolution_mode, 'STRICT_CANONICAL_REGISTRY');
    assert.equal(result.template.sha256, profile.sha256);
    assert.equal(path.basename(result.template.resolved_template_path), 'CHECKLIST.xlsx');
    await fs.access(result.template.resolved_template_path);
  }

  assert.equal(approvedCount, 19);
});

test('unknown customer cannot fall back to a similar historical checklist', async () => {
  const result = await resolveChecklistTemplateDetailed({
    customerCode: 'BEALLS DEPARTMENT',
    registryPath: REGISTRY_PATH
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CHECKLIST_CUSTOMER_NOT_REGISTERED');
});
