import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blockedCustomerSet,
  certifiedCustomerSet,
  isCertifiedCustomer,
  launchStatus
} from '../../src/po/productionWorkflow.js';

const allowed = [
  '10BELOW', 'BEALLSOUTL', 'CATO', 'CITI', 'COLONY', 'GABRIELBRO',
  'GORBRORET', 'ITSFASHION', 'MACYSBACKS', 'MARSHALLS',
  'MESALVEINC', 'OLLIES', 'SHOE4500', 'SPENCER',
  'TILLYS', 'VARIETYWHO', 'VERSONA', 'ZUMIEZ'
];

const blocked = [
  'CARNIVAL', 'HAMRICKS', 'IPC', 'MANDEE', 'TJMAXX'
];

test('all eighteen requested customers are eligible for the manual A2000 gate', () => {
  for (const code of allowed) {
    assert.equal(isCertifiedCustomer(code), true, code);
  }
});

test('the five evidence-blocked customers remain blocked', () => {
  for (const code of blocked) {
    assert.equal(isCertifiedCustomer(code), false, code);
  }
});

test('launch status exposes the same allowed and blocked policy', () => {
  const status = launchStatus();
  assert.deepEqual(
    [...certifiedCustomerSet()].sort(),
    allowed.sort()
  );
  assert.deepEqual(
    [...blockedCustomerSet()].sort(),
    blocked.sort()
  );
  assert.deepEqual(
    status.blocked_customers,
    blocked.sort()
  );
});
