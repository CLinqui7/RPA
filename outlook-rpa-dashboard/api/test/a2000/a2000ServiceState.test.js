import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyA2000RuntimeError,
  isTransientNoWriteJob
} from '../../src/a2000/a2000ServiceState.js';

test('HTTP 503 bridge error is service unavailable and never a write', () => {
  const result = classifyA2000RuntimeError(new Error(
    'A2000 OAuth failed. HTTP 503. Failure of Web Server bridge: No backend server available for connection'
  ));
  assert.equal(result.code, 'A2000_SERVICE_UNAVAILABLE');
  assert.equal(result.transient, true);
  assert.equal(result.write_performed, false);
  assert.match(result.message, /No se envió ORDER_HD ni ORDER_LI/);
});

test('old transient 503 job without payload is diagnostic only', () => {
  assert.equal(isTransientNoWriteJob({
    status: 'failed_preflight',
    last_error: {
      code: 'PREFLIGHT_EXCEPTION',
      http_status: 503,
      message: 'No backend server available for connection'
    },
    header_request: null,
    lines_request: null,
    a2000_seq_order_no: null,
    a2000_ctrl_no: null
  }), true);
});

test('a job with an ORDER_HD request is not hidden as diagnostic only', () => {
  assert.equal(isTransientNoWriteJob({
    last_error: {
      code: 'A2000_SERVICE_UNAVAILABLE',
      http_status: 503
    },
    header_request: { rows: [{ ORDER_NO: '1' }] }
  }), false);
});
