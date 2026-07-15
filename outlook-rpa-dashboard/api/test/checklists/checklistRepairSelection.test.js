import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChecklistRepairCandidate,
  checklistRepairGroupSafety,
  selectChecklistRepairGroups
} from '../../src/checklists/checklistRepairSelection.js';

test('data-rich duplicate is selected while A2000 control from another duplicate is preserved', () => {
  const emptyWithControl = buildChecklistRepairCandidate({
    order: {
      id: 'empty-control-row',
      customer_code: 'BEALLSOUTL',
      order_no: '1858445',
      store_code: '995',
      purchase_order_lines: []
    },
    canonicalCustomerCode: 'BEALLSOUTL',
    job: { a2000_ctrl_no: '3759001', updated_at: '2026-07-15T09:00:00Z' }
  });
  const richWithoutControl = buildChecklistRepairCandidate({
    order: {
      id: 'rich-data-row',
      customer_code: 'BEALLSOUTL',
      order_no: '1858445',
      store_code: '995',
      purchase_order_lines: [{ id: '1' }, { id: '2' }, { id: '3' }]
    },
    canonicalCustomerCode: 'BEALLSOUTL',
    job: null
  });

  const [group] = selectChecklistRepairGroups([emptyWithControl, richWithoutControl]);
  assert.equal(group.representative.order.id, 'rich-data-row');
  assert.equal(group.representative.source_line_count, 3);
  assert.equal(group.actual_control_no, '3759001');
  assert.equal(group.actual_control_source_order_id, 'empty-control-row');
  assert.equal(checklistRepairGroupSafety(group).ok, true);
});

test('conflicting A2000 controls block generation instead of guessing', () => {
  const first = buildChecklistRepairCandidate({
    order: {
      id: 'first', customer_code: 'VERSONA', order_no: '615628', store_code: 'DATOPS',
      purchase_order_lines: [{ id: '1' }]
    },
    canonicalCustomerCode: 'VERSONA',
    job: { a2000_ctrl_no: '3758993' }
  });
  const second = buildChecklistRepairCandidate({
    order: {
      id: 'second', customer_code: 'VERSONA', order_no: '615628', store_code: 'DATOPS',
      purchase_order_lines: [{ id: '2' }]
    },
    canonicalCustomerCode: 'VERSONA',
    job: { a2000_ctrl_no: '9999999' }
  });

  const [group] = selectChecklistRepairGroups([first, second]);
  const safety = checklistRepairGroupSafety(group);
  assert.equal(group.has_control_conflict, true);
  assert.deepEqual(group.conflicting_actual_controls.sort(), ['3758993', '9999999']);
  assert.equal(safety.ok, false);
  assert.equal(safety.reason, 'CONFLICTING_A2000_CONTROLS');
});

test('group with zero source lines is blocked before writing any workbook', () => {
  const candidate = buildChecklistRepairCandidate({
    order: {
      id: 'empty', customer_code: 'BEALLSOUTL', order_no: '1915414', store_code: '115',
      purchase_order_lines: []
    },
    canonicalCustomerCode: 'BEALLSOUTL',
    job: null
  });
  const [group] = selectChecklistRepairGroups([candidate]);
  const safety = checklistRepairGroupSafety(group);
  assert.equal(safety.ok, false);
  assert.equal(safety.reason, 'CHECKLIST_SOURCE_LINES_MISSING');
});
