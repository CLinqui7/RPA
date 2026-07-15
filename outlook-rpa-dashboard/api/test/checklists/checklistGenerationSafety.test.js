import test from 'node:test';
import assert from 'node:assert/strict';
import { validateChecklistEngineResult } from '../../src/checklists/checklistGenerationSafety.js';

test('empty generated workbook is rejected', () => {
  assert.deepEqual(validateChecklistEngineResult({ line_count: 0 }), {
    ok: false,
    reason: 'CHECKLIST_EMPTY_OUTPUT',
    line_count: 0
  });
});

test('non-empty generated workbook is accepted', () => {
  assert.deepEqual(validateChecklistEngineResult({ line_count: 3 }), {
    ok: true,
    reason: null,
    line_count: 3
  });
});
