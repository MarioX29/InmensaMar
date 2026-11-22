export type DeliveryPaymentEvent = {
  event_kind: 'pending' | 'payment';
  method: string;
  verified_at: string | null;
};
export type DeliveryRouteSummary = {
  total: number;
  delivered: number;
  cancelled: number;
  inProgress: number;
  returnPending: number;
  ready: number;
  progressTotal: number;
  progressPercent: number;
};
export function summarizeDeliveryRoute(states: string[]): DeliveryRouteSummary;
export function getDeliveryPaymentLabel(events: DeliveryPaymentEvent[]): string;
export function calculateReturnAmounts(dispatched: number, good: number): { good: number; damaged: number };
