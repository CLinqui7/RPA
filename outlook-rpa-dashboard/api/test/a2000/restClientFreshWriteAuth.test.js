import test from 'node:test';
import assert from 'node:assert/strict';
import { A2000RestClient } from '../../src/a2000/restClient.js';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    text: async () => JSON.stringify(body)
  };
}

test('Upload POST forces a brand-new OAuth token immediately before write', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({
      url: String(url),
      method: options.method,
      authorization: options.headers?.Authorization
    });

    if (String(url).endsWith('/api/oauth/token')) {
      return response(200, {
        access_token: 'fresh-write-token',
        expires_in: 3600,
        token_type: 'bearer'
      });
    }

    return response(200, {
      status: 'Success',
      updated: 1,
      data: [{ SEQ_ORDER_NO: 999 }]
    });
  };

  try {
    const client = new A2000RestClient({
      baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
      clientId: 'client',
      clientSecret: 'secret'
    });

    client.token = 'old-still-not-expired';
    client.tokenExpiresAt = Date.now() + 3_000_000;

    const result = await client.upload('ORDER_HD', {
      IGNORE_ERRORS: 'N',
      ORDER_HD: [{ ORDER_NO: 'TEST' }]
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(calls.filter(call => call.url.endsWith('/api/oauth/token')).length, 1);
    assert.equal(calls.filter(call => call.url.includes('/api/uploads/upload/ORDER_HD')).length, 1);
    assert.equal(
      calls.find(call => call.url.includes('/api/uploads/upload/ORDER_HD'))?.authorization,
      'Bearer fresh-write-token'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Upload POST 401 is returned after exactly one POST and is never blindly retried', async () => {
  const originalFetch = globalThis.fetch;
  let oauthCalls = 0;
  let uploadCalls = 0;

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/oauth/token')) {
      oauthCalls += 1;
      return response(200, {
        access_token: `fresh-${oauthCalls}`,
        expires_in: 3600,
        token_type: 'bearer'
      });
    }

    uploadCalls += 1;
    return response(401, { status: 'Fail', updated: 0 });
  };

  try {
    const client = new A2000RestClient({
      baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
      clientId: 'client',
      clientSecret: 'secret'
    });

    const result = await client.upload('ORDER_LI', {
      IGNORE_ERRORS: 'N',
      ORDER_LI: [{ ORDER_NO: 'TEST' }]
    });

    assert.equal(result.httpStatus, 401);
    assert.equal(oauthCalls, 1);
    assert.equal(uploadCalls, 1);
    assert.equal(result.authRefreshAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
