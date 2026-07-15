import test from 'node:test';
import assert from 'node:assert/strict';
import { actualControlFromJob } from '../../src/checklists/checklistJobControl.js';

test('orders without an A2000 job remain pending instead of crashing', () => {
  assert.equal(actualControlFromJob(null), '');
  assert.equal(actualControlFromJob(undefined), '');
  assert.equal(actualControlFromJob({}), '');
});

test('actual A2000 control is preferred when available', () => {
  assert.equal(actualControlFromJob({ a2000_ctrl_no: ' 3758993 ' }), '3758993');
  assert.equal(
    actualControlFromJob({ a2000_ctrl_no: '', a2000_seq_order_no: ' 98765 ' }),
    '98765'
  );
});
