export function summarizeDeliveryRoute(states) {
  const delivered = states.filter((state) => state === 'delivered').length;
  const cancelled = states.filter((state) => state === 'cancelled').length;
  const inProgress = states.filter((state) => state === 'out_for_delivery').length;
  const returnPending = states.filter((state) => state === 'return_pending').length;
  const ready = states.filter((state) => state === 'ready').length;
  const progressTotal = Math.max(0, states.length - cancelled);

  return {
    total: states.length,
    delivered,
    cancelled,
    inProgress,
    returnPending,
    ready,
    progressTotal,
    progressPercent: progressTotal === 0 ? 0 : Math.round((delivered / progressTotal) * 100),
  };
}

export function getDeliveryPaymentLabel(events) {
  const payment = events.find((event) => event.event_kind === 'payment');
  if (payment?.method === 'cash') return 'Efectivo recibido';
  if (payment?.method === 'transfer_reported') {
    return payment.verified_at ? 'Transferencia verificada' : 'Transferencia por verificar';
  }
  if (events.some((event) => event.event_kind === 'pending')) return 'Pago pendiente';
  return 'Sin pago registrado';
}

export function calculateReturnAmounts(dispatched, good) {
  if (!Number.isFinite(dispatched) || !Number.isFinite(good) || dispatched < 0 || good < 0 || good > dispatched) {
    throw new Error('La cantidad en buen estado debe estar entre cero y lo despachado.');
  }
  return {
    good: Math.round(good * 10000) / 10000,
    damaged: Math.round((dispatched - good) * 10000) / 10000,
  };
}

export function deliveryOrderStatusLabel(status) {
  const labels = {
    received: 'Recibido',
    accepted: 'Aceptado',
    preparing: 'En preparación',
    ready: 'Listo',
    out_for_delivery: 'En reparto',
    return_pending: 'Regreso al local',
    delivered: 'Entregado',
    cancelled: 'Cancelado',
  };
  return labels[status] || 'Estado no disponible';
}

export function formatDeliveryQuantity(quantity) {
  if (!Number.isFinite(quantity)) return '—';
  return new Intl.NumberFormat('es-GT', { maximumFractionDigits: 4 }).format(quantity);
}
