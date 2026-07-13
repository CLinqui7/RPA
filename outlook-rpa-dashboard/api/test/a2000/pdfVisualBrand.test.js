import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hammingDistanceHex,
  identifyVisualBrandBySignature
} from '../../src/po/pdfVisualBrand.js';

const VERSONA = '78000000f4000000fedfdb4afeecd7f2fa6eddf7b24ffb55e40000007c000000';
const ITSFASHION = '0000000028302200ff3ffff8e72ffff8e72ffff8f72ffff80000888800000000';

test('Versona canonical logo signature resolves as VERSONA', () => {
  assert.equal(identifyVisualBrandBySignature(VERSONA)?.code, 'VERSONA');
});

test("It's Fashion canonical logo signature resolves as ITSFASHION", () => {
  assert.equal(identifyVisualBrandBySignature(ITSFASHION)?.code, 'ITSFASHION');
});

test('Versona and Its Fashion visual signatures are materially distinct', () => {
  assert.ok(hammingDistanceHex(VERSONA, ITSFASHION) > 50);
});

test('unknown signature is not auto-accepted', () => {
  assert.equal(identifyVisualBrandBySignature('f'.repeat(64)), null);
});
