import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateReturnAmounts, getDeliveryPaymentLabel, summarizeDeliveryRoute } from '../src/delivery/deliveryPresentation.js';

test('route progress excludes cancelled orders from the completion denominator', () => {
  assert.deepEqual(summarizeDeliveryRoute(['cancelled', 'cancelled', 'delivered', 'delivered', 'out_for_delivery']), {
    total: 5, delivered: 2, cancelled: 2, inProgress: 1, returnPending: 0, ready: 0, progressTotal: 3, progressPercent: 67,
  });
});

test('route with only cancelled stops has no progress denominator', () => {
  assert.equal(summarizeDeliveryRoute(['cancelled']).progressPercent, 0);
});

test('delivery payment labels distinguish cash, reported and verified transfers, and pending', () => {
  assert.equal(getDeliveryPaymentLabel([{ event_kind: 'payment', method: 'cash', verified_at: null }]), 'Efectivo recibido');
  assert.equal(getDeliveryPaymentLabel([{ event_kind: 'payment', method: 'transfer_reported', verified_at: null }]), 'Transferencia por verificar');
  assert.equal(getDeliveryPaymentLabel([{ event_kind: 'payment', method: 'transfer_reported', verified_at: '2026-11-22T10:00:00Z' }]), 'Transferencia verificada');
  assert.equal(getDeliveryPaymentLabel([{ event_kind: 'pending', method: 'pending', verified_at: null }]), 'Pago pendiente');
});

test('return reconciliation calculates damaged quantity only after explicit good quantity', () => {
  assert.deepEqual(calculateReturnAmounts(3.5, 2), { good: 2, damaged: 1.5 });
  assert.throws(() => calculateReturnAmounts(3, 3.1));
});

test('route detail uses human-readable delivery order statuses', async () => {
  const { deliveryOrderStatusLabel } = await import('../src/delivery/deliveryPresentation.js');
  assert.equal(deliveryOrderStatusLabel('out_for_delivery'), 'En reparto');
  assert.equal(deliveryOrderStatusLabel('return_pending'), 'Regreso al local');
  assert.equal(deliveryOrderStatusLabel('delivered'), 'Entregado');
  assert.equal(deliveryOrderStatusLabel('cancelled'), 'Cancelado');
  assert.equal(deliveryOrderStatusLabel('unknown'), 'Estado no disponible');
});

test('route detail formats quantities without unnecessary trailing zeroes', async () => {
  const { formatDeliveryQuantity } = await import('../src/delivery/deliveryPresentation.js');
  assert.equal(formatDeliveryQuantity(2), '2');
  assert.equal(formatDeliveryQuantity(1.25), '1.25');
  assert.equal(formatDeliveryQuantity(Number.NaN), '—');
});
