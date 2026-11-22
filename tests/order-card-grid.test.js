import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const design = readFileSync(new URL('../src/design-system.css', import.meta.url), 'utf8');
const panel = readFileSync(new URL('../src/orders/OrdersPanel.tsx', import.meta.url), 'utf8');

test('orders board overrides legacy shell rule with adaptive compact grid', () => {
  assert.match(design, /\.shell \.orders-module \.op-orders\{[\s\S]*?grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,280px\),1fr\)\)/);
  assert.match(design, /\.shell \.orders-module \.op-orders\{[\s\S]*?background:transparent/);
});

test('each order renders as an individual bordered tile', () => {
  assert.match(design, /\.shell \.orders-module \.op-order,[\s\S]*?border:1px solid var\(--im-line\)/);
});

test('order actions menu is in the card header, not detached below the total', () => {
  assert.match(panel, /op-order-head-tools[\s\S]*?order-more-options/);
  assert.doesNotMatch(panel, /<div className="op-actions">[\s\S]*?order-more-options/);
});

test('product details have a single concise disclosure label', () => {
  assert.match(panel, /<details className="op-order-detail"><summary><span>Productos/);
  assert.doesNotMatch(panel, /op-detail-hint/);
});
