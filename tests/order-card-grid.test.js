import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/orders/orders.css', import.meta.url), 'utf8');

test('order cards use one column by default for narrow mobile screens', () => {
  assert.match(css, /\.op-orders\{grid-template-columns:minmax\(0,1fr\);align-items:start\}/);
});

test('order cards use two columns on tablet widths', () => {
  assert.match(css, /@media\(min-width:680px\)\{\.op-orders\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('order cards use three columns on wide desktop widths', () => {
  assert.match(css, /@media\(min-width:980px\)\{\.op-orders\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('order group headings span the whole card grid', () => {
  assert.match(css, /\.order-group-title\{grid-column:1\/-1\}/);
});
