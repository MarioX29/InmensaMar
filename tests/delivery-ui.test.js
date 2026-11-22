import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../src/delivery/DeliveryPanel.tsx', import.meta.url), 'utf8');
const returns = readFileSync(new URL('../src/delivery/DeliveryReturnsPanel.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/delivery/delivery.css', import.meta.url), 'utf8');

test('active delivery routes render compact independent cards and expandable stop details', () => {
  assert.match(panel, /className=\{`delivery-route-grid\$\{activeRoutes\.length===1\?' is-single':''\}`\}/);
  assert.match(panel, /className="delivery-route-card"/);
  assert.match(panel, /Ver pedidos de esta salida/);
});

test('route cards summarize delivered, in-progress, returned, ready, and cancelled stops', () => {
  assert.match(panel, /summary\.delivered/);
  assert.match(panel, /summary\.inProgress/);
  assert.match(panel, /summary\.returnPending/);
  assert.match(panel, /summary\.ready/);
  assert.match(panel, /summary\.cancelled/);
});

test('return quantities require an explicit physical count before confirmation', () => {
  assert.match(returns, /values\[line\.movement_id\]===undefined\|\|values\[line\.movement_id\]\.trim\(\)===''/);
  assert.match(returns, /placeholder="Cantidad recibida"/);
  assert.match(returns, /Confirmar recepción física/);
});

test('delivery UI is responsive with three, two, and one column breakpoints', () => {
  assert.match(styles, /\.delivery-route-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media\(max-width:1000px\)\{\.delivery-route-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(styles, /@media\(max-width:700px\)\{\.delivery-route-grid,\.delivery-return-grid\{grid-template-columns:1fr\}/);
});

test('collection statuses distinguish pending payments, transfer review and confirmed receipts', () => {
  assert.match(panel, /Transferencia por verificar/);
  assert.match(panel, /Transferencia verificada/);
  assert.match(panel, /Efectivo recibido/);
  assert.match(panel, /Pago pendiente/);
});

test('uncertain return submissions can be retried with the same persisted request after reload', () => {
  assert.match(returns, /if\(pending\)\{\s*\/\/ Retry the exact persisted request/);
  assert.match(returns, /pending\?\.orderId===orderId\|\|group\.every/);
});


test('a single active route uses the full available width with a horizontal summary', () => {
  assert.match(panel, /activeRoutes\.length===1/);
  assert.match(styles, /\.delivery-route-grid\.is-single\{grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(styles, /\.delivery-route-grid\.is-single \.delivery-route-card\{grid-template-columns:/);
});

test('route progress label makes clear cancelled orders are excluded from the denominator', () => {
  assert.match(panel, /Progreso de pedidos activos/);
  assert.match(panel, /summary\.progressTotal===0\?'Sin pedidos activos':`\$\{summary\.delivered\} de \$\{summary\.progressTotal\}`/);
});

test('a single pending collection uses the full available width', () => {
  assert.match(panel, /delivery-collection-grid\$\{latePending\.length\+transferReview\.length===1\?' is-single':''\}/);
  assert.match(styles, /\.delivery-collection-grid\.is-single\{grid-template-columns:minmax\(0,1fr\)\}/);
});
