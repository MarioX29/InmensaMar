import test from 'node:test';
import assert from 'node:assert/strict';
import { poundsAndOuncesToQuantity, quantityToPoundsAndOunces } from '../src/lib/weight.js';

test('one pound and four ounces become 1.25 inventory pounds', () => {
  assert.equal(poundsAndOuncesToQuantity(1, 4), 1.25);
});

test('32 ounces normalize to two pounds', () => {
  assert.equal(poundsAndOuncesToQuantity(0, 32), 2);
  assert.deepEqual(quantityToPoundsAndOunces(2), { pounds: 2, ounces: 0 });
});

test('36 ounces normalize to two pounds and four ounces', () => {
  const quantity = poundsAndOuncesToQuantity(0, 36);
  assert.equal(quantity, 2.25);
  assert.deepEqual(quantityToPoundsAndOunces(quantity), { pounds: 2, ounces: 4 });
});

test('overflowing ounces carry into pounds after adding existing pounds', () => {
  const quantity = poundsAndOuncesToQuantity(2, 40);
  assert.equal(quantity, 4.5);
  assert.deepEqual(quantityToPoundsAndOunces(quantity), { pounds: 4, ounces: 8 });
});

test('the round trip keeps quarter-ounce precision used by the existing quantity scale', () => {
  const quantity = poundsAndOuncesToQuantity(3, 0.25);
  assert.equal(quantity, 3.0156);
  const parts = quantityToPoundsAndOunces(quantity);
  assert.equal(parts.pounds, 3);
  assert.equal(parts.ounces, 0.2496);
});
