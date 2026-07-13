import test from 'node:test';
import assert from 'node:assert/strict';
import { A2000RestClient } from '../../src/a2000/restClient.js';

function response(status, body = {}, contentType = 'application/json') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type'
          ? contentType
          : null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
  };
}

test('safe Viewer read can force-refresh OAuth twice and recover after two 401 responses', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  let oauthNo = 0;
  let viewerNo = 0;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method });

    if (String(url).endsWith('/api/oauth/token')) {
      oauthNo += 1;
      return response(200, {
        access_token: `token-${oauthNo}`,
        token_type: 'bearer',
        expires_in: 3600
      });
    }

    if (String(url).includes('/api/viewers/view/VR_SKU_Z')) {
      viewerNo += 1;
      if (viewerNo <= 2) return response(401, { error: 'expired' });
      return response(200, {
        VR_SKU_Z: [{ STYLE: 'HAMPTON', CLR: 'TSI' }]
      });
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const client = new A2000RestClient({
      baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
      clientId: 'id',
      clientSecret: 'secret'
    });

    const result = await client.viewer('VR_SKU_Z', {
      columns: ['STYLE', 'CLR'],
      filter: "STYLE='HAMPTON' AND CLR='TSI'",
      sort: 'SIZE_NUM'
    });

    assert.equal(result.httpStatus, 200);
    assert.equal(result.rows.length, 1);
    assert.equal(result.authRefreshAttempts, 2);
    assert.equal(oauthNo, 3);
    assert.equal(viewerNo, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Upload POST is never retried after HTTP 401', async () => {
  const originalFetch = global.fetch;
  let oauthNo = 0;
  let uploadNo = 0;

  global.fetch = async (url) => {
    if (String(url).endsWith('/api/oauth/token')) {
      oauthNo += 1;
      return response(200, {
        access_token: 'token-write',
        token_type: 'bearer',
        expires_in: 3600
      });
    }

    if (String(url).includes('/api/uploads/upload/ORDER_LI')) {
      uploadNo += 1;
      return response(401, { error: 'expired' });
    }

    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const client = new A2000RestClient({
      baseUrl: 'https://amextest.a2000cloud.com:8890/ords/amxtest',
      clientId: 'id',
      clientSecret: 'secret'
    });

    const result = await client.upload('ORDER_LI', {
      IGNORE_ERRORS: 'N',
      ORDER_LI: []
    });

    assert.equal(result.httpStatus, 401);
    assert.equal(uploadNo, 1);
    assert.equal(oauthNo, 1);
    assert.equal(result.authRefreshAttempts, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
