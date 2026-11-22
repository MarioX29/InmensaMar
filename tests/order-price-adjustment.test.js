import test from 'node:test';
import assert from 'node:assert/strict';

function lineTotalCents(quantity, unitPriceCents) {
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('invalid quantity');
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) throw new Error('invalid price');
  return Math.round(quantity * unitPriceCents);
}

test('calculates a negotiated line total from the agreed unit price', () => {
  assert.equal(lineTotalCents(30, 3700), 111000);
});

test('supports fractional-pound order quantities', () => {
  assert.equal(lineTotalCents(1.25, 4000), 5000);
});

test('allows a zero-priced line only when explicitly recorded', () => {
  assert.equal(lineTotalCents(2, 0), 0);
});

test('rejects negative prices', () => {
  assert.throws(() => lineTotalCents(2, -100), /invalid price/);
});

test('rejects non-integer cents', () => {
  assert.throws(() => lineTotalCents(2, 100.5), /invalid price/);
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const orderPanel = readFileSync(join(here, '../src/orders/OrdersPanel.tsx'), 'utf8');
const migration = readFileSync(join(here, '../supabase/migrations/20261120_02_order_line_price_adjustments.sql'), 'utf8');

test('shows price editing only to admin before dispatch', () => {
  assert.match(orderPanel, /staffRole==='admin'&&\['received','accepted','preparing','ready'\]\.includes\(o\.status\)/);
  assert.match(orderPanel, /admin_adjust_order_line_price/);
});

test('price adjustment is audited and does not edit catalog prices', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.admin_order_price_events/);
  assert.match(migration, /previous_unit_price_cents/);
  assert.match(migration, /new_unit_price_cents/);
  assert.match(migration, /UPDATE public\.customer_order_lines/);
  assert.match(migration, /UPDATE public\.customer_orders/);
  assert.doesNotMatch(migration, /UPDATE public\.product_variants/);
});

test('RPC rejects anonymous execution and requires an active admin role', () => {
  assert.match(migration, /staff_has_role\(ARRAY\['admin'\]::text\[\]\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.admin_adjust_order_line_price[\s\S]*FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.admin_adjust_order_line_price[\s\S]*TO authenticated/);
});
