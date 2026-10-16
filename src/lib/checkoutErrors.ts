export function errorMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const error = value as Record<string, unknown>;
    for (const field of ['message', 'details', 'hint', 'error', 'code']) {
      const candidate = error[field];
      if (typeof candidate === 'string' && candidate.trim() && candidate !== '[object Object]') {
        return candidate;
      }
    }
  }
  return 'No se pudo determinar el error. Verificá la operación antes de reintentar.';
}

export function isDefinitiveStockRejection(message: string): boolean {
  return /Insufficient available inventory|Product unavailable|Invalid quantity|Invalid sale request/i.test(message);
}
