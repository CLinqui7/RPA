import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checklistInternalControlKey,
  checklistControlGroupKey,
  provisionalChecklistControlNo
} from '../../src/checklists/checklistControlIdentity.js';

test('pending control identity is stable across duplicate purchase_order rows', () => {
  const first = {
    id: 'first-uuid',
    customer_code: 'ZUMIEZ',
    order_no: '476085',
    store_code: '995'
  };
  const duplicate = {
    id: 'second-uuid',
    customer_code: 'ZUMIEZ',
    order_no: '476085',
    store_code: '995'
  };

  assert.equal(checklistInternalControlKey(first), '476085|STORE:995');
  assert.equal(checklistInternalControlKey(duplicate), '476085|STORE:995');
  assert.equal(provisionalChecklistControlNo(first), provisionalChecklistControlNo(duplicate));
  assert.equal(
    checklistControlGroupKey(first, 'ZUMIEZ'),
    checklistControlGroupKey(duplicate, 'ZUMIEZ')
  );
});

test('different controls do not collapse into one pending checklist', () => {
  const first = {
    customer_code: 'BEALLSOUTL',
    order_no: '1857601',
    store_code: '995'
  };
  const second = {
    customer_code: 'BEALLSOUTL',
    order_no: '1817648',
    store_code: '995'
  };

  assert.notEqual(checklistInternalControlKey(first), checklistInternalControlKey(second));
  assert.notEqual(provisionalChecklistControlNo(first), provisionalChecklistControlNo(second));
});

test('canonical customer code controls grouping across aliases', () => {
  const aliasOrder = {
    customer_code: 'SIMPLY10',
    order_no: '72041',
    store_code: 'SIMPLY10'
  };
  const canonicalOrder = {
    customer_code: '10BELOW',
    order_no: '72041',
    store_code: 'SIMPLY10'
  };

  assert.equal(
    checklistControlGroupKey(aliasOrder, '10BELOW'),
    checklistControlGroupKey(canonicalOrder, '10BELOW')
  );
});
