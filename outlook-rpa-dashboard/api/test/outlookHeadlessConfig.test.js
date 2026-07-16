import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveOutlookHeadless
} from '../src/config.js';

test('Codespaces without a display always uses headless Chromium', () => {
  assert.equal(
    resolveOutlookHeadless({
      requested: 'false',
      display: '',
      waylandDisplay: ''
    }),
    true
  );
});

test('headed mode remains available when a display exists', () => {
  assert.equal(
    resolveOutlookHeadless({
      requested: 'false',
      display: ':99',
      waylandDisplay: ''
    }),
    false
  );
});

test('explicit headless mode wins even when a display exists', () => {
  assert.equal(
    resolveOutlookHeadless({
      requested: 'true',
      display: ':99',
      waylandDisplay: ''
    }),
    true
  );
});
