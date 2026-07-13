import test from 'node:test';
import assert from 'node:assert/strict';

import {
  A2000RestClient
} from '../../src/a2000/restClient.js';

function client(overrides = {}) {
  return new A2000RestClient({
    baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
    clientId: 'test-client',
    clientSecret: 'test-secret',
    ...overrides
  });
}

test('shared ORDER_LI requires explicit manual CLEAR confirmation before writes', () => {
  const previous = process.env.A2000_ORDER_LI_CLEARED;
  delete process.env.A2000_ORDER_LI_CLEARED;

  try {
    assert.throws(
      () => client().assertSharedLineUploadCleared(),
      /ORDER_LI/
    );

    process.env.A2000_ORDER_LI_CLEARED = 'YES';

    assert.doesNotThrow(
      () => client().assertSharedLineUploadCleared()
    );
  } finally {
    if (previous === undefined) {
      delete process.env.A2000_ORDER_LI_CLEARED;
    } else {
      process.env.A2000_ORDER_LI_CLEARED = previous;
    }
  }
});

test('production writes remain blocked without the explicit production gate', () => {
  const previous = process.env.A2000_ALLOW_PRODUCTION_WRITES;
  delete process.env.A2000_ALLOW_PRODUCTION_WRITES;

  const prod = client({
    baseUrl: 'https://prod.example.com/ords/amxprod',
    headerUploadId: 'RPA_ORDER_HD',
    lineUploadId: 'RPA_ORDER_LI'
  });

  try {
    assert.throws(
      () => prod.assertWriteEnvironment(),
      /Production A2000 REST write blocked/
    );
  } finally {
    if (previous === undefined) {
      delete process.env.A2000_ALLOW_PRODUCTION_WRITES;
    } else {
      process.env.A2000_ALLOW_PRODUCTION_WRITES = previous;
    }
  }
});

test('AMEXTEST passes the production-environment write gate', () => {
  assert.doesNotThrow(
    () => client().assertWriteEnvironment()
  );
});
