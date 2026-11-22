import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const quantityInput = readFileSync(new URL('../src/components/QuantityInput.tsx', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
const quantityCss = readFileSync(new URL('../src/components/quantity-input.css', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const designStyles = readFileSync(new URL('../src/design-system.css', import.meta.url), 'utf8');

test('pound and ounce changes recalculate without an Apply button', () => {
  assert.match(quantityInput, /onChange=\{event => \{ const next = event\.target\.value; setPounds\(next\); setError\(''\); commitPounds\(next, ounces\); \}\}/);
  assert.match(quantityInput, /onChange=\{event => \{ const next = event\.target\.value; setOunces\(next\); setError\(''\); commitPounds\(pounds, next\); \}\}/);
  assert.doesNotMatch(quantityInput, /im-quantity-apply|>Aplicar</);
  assert.doesNotMatch(quantityCss, /im-quantity-apply/);
});

test('normalization is shown as quiet helper text without redundant equivalence labels', () => {
  assert.match(quantityInput, /aria-live="polite"/);
  assert.ok(quantityInput.includes('normalizedPounds} lb + ${normalizedOunces}'));
  assert.doesNotMatch(quantityInput, /Equivale a/);
});

test('POS removes a line with an accessible X icon in the line header', () => {
  assert.match(main, /className="cart-line-head"/);
  assert.ok(main.includes('aria-label={`Eliminar ${product.name}`} title="Eliminar producto"><X size={17}'));
  assert.doesNotMatch(main, /className="remove-line"[^>]*>Quitar</);
  assert.match(styles, /\.remove-line\{display:grid/);
  assert.match(designStyles, /\.cart-line-head \.remove-line/);
});
