import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const panel = readFileSync(new URL('../src/delivery/DeliveryPanel.tsx', import.meta.url), 'utf8');
const returns = readFileSync(new URL('../src/delivery/DeliveryReturnsPanel.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/delivery/delivery.css', import.meta.url), 'utf8');

test('active delivery routes expand inline in the same Reparto view', () => {
  assert.match(panel, /<details className="delivery-route-card delivery-route-details-card"/);
  assert.match(panel, /<summary className="delivery-route-summary">/);
  assert.match(panel, /Ver \{assigned\.length\}/);
  assert.doesNotMatch(panel, /selectedRouteId|setSelectedRouteId|Volver a salidas|Abrir salida/);
});

test('route details show customers, contact, address, products, instructions and payment state', () => {
  assert.match(panel, /order\?\.customer_name/);
  assert.match(panel, /order\.customer_phone/);
  assert.match(panel, /order\.delivery_address/);
  assert.match(panel, /orderLines\.filter/);
  assert.match(panel, /order\?\.notes/);
  assert.match(panel, /getDeliveryPaymentLabel\(events\)/);
  assert.match(panel, /delivery-route-order-card/);
});

test('route summary shows progress excluding cancelled orders and names the active denominator', () => {
  assert.match(panel, /Entregas activas/);
  assert.match(panel, /summary\.progressTotal===0\?'Sin pedidos activos':`\$\{summary\.delivered\} de \$\{summary\.progressTotal\}`/);
  assert.match(panel, /summary\.cancelled/);
});

test('one active route spans the available width and the grid adapts to screen size', () => {
  assert.match(panel, /activeRoutes\.length===1\?' is-single'/);
  assert.match(styles, /\.delivery-route-grid\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  assert.match(styles, /\.delivery-route-grid\.is-single> \.delivery-route-details-card\{grid-column:1\/-1\}/);
  assert.match(styles, /@media\(max-width:1000px\)\{\.delivery-route-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
  assert.match(styles, /@media\(max-width:700px\)\{\.delivery-route-grid,\.delivery-return-grid\{grid-template-columns:1fr\}/);
});

test('collections are summarized by payment type instead of repeated individual cards', () => {
  assert.match(panel, /Efectivo pendiente/);
  assert.match(panel, /Transferencias por verificar/);
  assert.match(panel, /cashPendingTotal/);
  assert.match(panel, /transferReviewTotal/);
  assert.match(panel, /Las transferencias reportadas se revisan y confirman desde Finanzas/);
  assert.doesNotMatch(panel, /delivery-collection-card/);
});

test('individual cash collection actions remain available inside a collapsed list', () => {
  assert.match(panel, /<details className="delivery-cash-pending-details">/);
  assert.match(panel, /Registrar cobros en efectivo/);
  assert.match(panel, /setConfirm\(\{kind:'delivery',id:order\.id\}\)/);
});

test('return quantities require an explicit physical count before confirmation', () => {
  assert.match(returns, /values\[line\.movement_id\]===undefined\|\|values\[line\.movement_id\]\.trim\(\)===''/);
  assert.match(returns, /placeholder="Cantidad recibida"/);
  assert.match(returns, /Confirmar recepción física/);
});

test('uncertain return submissions can be retried with the same persisted request after reload', () => {
  assert.match(returns, /if\(pending\)\{\s*\/\/ Retry the exact persisted request/);
  assert.match(returns, /pending\?\.orderId===orderId\|\|group\.every/);
});
