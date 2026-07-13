import test from 'node:test';
import assert from 'node:assert/strict';
import { A2000RestClient } from '../../src/a2000/restClient.js';

function client() {
  return new A2000RestClient({
    baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
    clientId: 'test-id',
    clientSecret: 'test-secret'
  });
}

test('OAuth safely retries 503 twice and succeeds on the third attempt', async () => {
  const originalFetch = globalThis.fetch;
  const originalDelays = process.env.A2000_OAUTH_RETRY_DELAYS_MS;
  let calls = 0;

  process.env.A2000_OAUTH_RETRY_DELAYS_MS = '0,0,0';
  globalThis.fetch = async () => {
    calls += 1;
    if (calls < 3) {
      return new Response(
        '<html>No backend server available for connection</html>',
        { status: 503 }
      );
    }

    return new Response(JSON.stringify({
      access_token: 'token-value',
      token_type: 'Bearer',
      expires_in: 3600
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await client().refreshToken();
    assert.equal(calls, 3);
    assert.equal(result.attempts, 3);
    assert.ok(result.token_length > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDelays === undefined) {
      delete process.env.A2000_OAUTH_RETRY_DELAYS_MS;
    } else {
      process.env.A2000_OAUTH_RETRY_DELAYS_MS = originalDelays;
    }
  }
});

test('OAuth does not keep retrying a non-transient 401', async () => {
  const originalFetch = globalThis.fetch;
  const originalDelays = process.env.A2000_OAUTH_RETRY_DELAYS_MS;
  let calls = 0;

  process.env.A2000_OAUTH_RETRY_DELAYS_MS = '0,0,0';
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  };

  try {
    await assert.rejects(
      () => client().refreshToken(),
      /HTTP 401/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDelays === undefined) {
      delete process.env.A2000_OAUTH_RETRY_DELAYS_MS;
    } else {
      process.env.A2000_OAUTH_RETRY_DELAYS_MS = originalDelays;
    }
  }
});
