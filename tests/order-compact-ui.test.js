import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../src/orders/OrdersPanel.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/orders/orders.css', import.meta.url), 'utf8');

test('active orders keep product details collapsed until requested', () => {
  assert.match(panel, /<details className="op-order-detail"><summary>/);
  assert.doesNotMatch(panel, /<details className="op-order-detail" open=/);
  assert.match(panel, /linesForOrder\.length===1\?'1 producto':`\$\{linesForOrder\.length\} productos`/);
});

test('delivery and payment information is available in a separate disclosure', () => {
  assert.match(panel, /className="op-order-extra"/);
  assert.match(panel, /<OrderDeliveryInfo info=\{deliveryDetails\}[^>]*showNotes\/>/);
});

test('order status is shown once without the redundant ready-to-dispatch sentence', () => {
  assert.match(panel, /className=\{`op-status op-status-\$\{o\.status\}`\}/);
  assert.doesNotMatch(panel, /Listo para que un repartidor lo tome/);
});

test('secondary order actions use an accessible three-dot menu', () => {
  assert.match(panel, /className="order-more-options"><summary aria-label="Más opciones del pedido"/);
  assert.match(panel, /className="order-more-menu"/);
});

test('compact order cards use one column on phones, two on tablets, and three on desktops', () => {
  assert.match(css, /\.op-orders\{grid-template-columns:minmax\(0,1fr\);align-items:start\}/);
  assert.match(css, /@media\(min-width:680px\)\{\.op-orders\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(css, /@media\(min-width:980px\)\{\.op-orders\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('new-order product removal uses a discreet accessible X control', () => {
  assert.match(panel, /className="op-remove-line" aria-label=\{`Eliminar \$\{p\.name\} del pedido`\}/);
  assert.doesNotMatch(panel, /className="op-outline" disabled=\{busy\} onClick=\{\(\)=>setItems\(old=>old\.filter\(item=>item\.variant_id!==p\.id\)\)\}>Quitar/);
});


test('three-dot order menus close on outside clicks and Escape, with only one open', () => {
  assert.match(panel, /document\.addEventListener\('pointerdown',closeOtherMenus\)/);
  assert.match(panel, /document\.addEventListener\('keydown',closeMenusOnEscape\)/);
  assert.match(panel, /event\.key!=='Escape'/);
  assert.match(panel, /if\(menu!==clickedMenu\)menu\.open=false/);
  assert.match(panel, /document\.addEventListener\('click',closeSelectedMenu\)/);
  assert.match(panel, /removeAttribute\('open'\)/);
});
