import {businessDate} from '../ui/dates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import './driver-cash-float.css';

type CashDay = { id: string; business_date: string; status: string };
type FloatRecord = { id: string; cash_day_id: string; amount_cents: number; declared_at: string };
const formatMoney = (cents: number) => `Q ${(cents / 100).toFixed(2)}`;
const errorMessage = (e: unknown) => e && typeof e === 'object' && 'message' in e ? String(e.message) : 'No se pudo completar la operación.';

export function DriverCashFloat() {
  const [day, setDay] = useState<CashDay | null>(null);
  const [record, setRecord] = useState<FloatRecord | null>(null);
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const request = useRef<{ id: string; cents: number } | null>(null);

  const refresh = useCallback(async () => {
    if (!supabase) { setError('No hay conexión con Supabase.'); setLoading(false); return; }
    const { data: userResult, error: userError } = await supabase.auth.getUser();
    const userId = userResult.user?.id;
    if (userError || !userId) { setError('Iniciá sesión nuevamente para consultar tu sencillo.'); setLoading(false); return; }
    const { data: days, error: dayError } = await supabase.from('cash_days')
      .select('id,business_date,status').eq('status', 'open').limit(1);
    if (dayError) { setError(errorMessage(dayError)); setLoading(false); return; }
    const currentDay = (days?.[0] || null) as CashDay | null;
    setDay(currentDay);
    if (!currentDay) { setRecord(null); setError(''); setLoading(false); return; }
    const { data: floats, error: floatError } = await supabase.from('driver_cash_floats')
      .select('id,cash_day_id,amount_cents,declared_at')
      .eq('cash_day_id', currentDay.id).eq('driver_id', userId).limit(1);
    if (floatError) { setError(errorMessage(floatError)); setLoading(false); return; }
    setRecord((floats?.[0] || null) as FloatRecord | null);
    setError(''); setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  async function declareFloat() {
    if (!supabase || !day || record || saving) return;
    const text = amount.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(text)) { setError('Ingresá un monto válido, por ejemplo 100.00.'); return; }
    const cents = Math.round(Number(text) * 100);
    if (!Number.isSafeInteger(cents) || cents < 0) { setError('El monto no es válido.'); return; }
    if (request.current && request.current.cents !== cents) {
      setError('Hay una declaración pendiente de confirmar. Actualizá antes de cambiar el monto.'); return;
    }
    if (!request.current) request.current = { id: crypto.randomUUID(), cents };
    setSaving(true); setError(''); setMessage('');
    try {
      const { error: rpcError } = await supabase.rpc('declare_driver_cash_float', {
        p_request_id: request.current.id, p_amount_cents: cents,
      });
      if (rpcError) { setError(`${errorMessage(rpcError)}. Revisá si se registró antes de volver a intentar.`); return; }
      request.current = null;
      setMessage('Sencillo declarado correctamente.');
      await refresh();
    } catch (e) {
      setError(`${errorMessage(e)}. Verificá el registro antes de reintentar.`);
    } finally { setSaving(false); }
  }

  return <section className="delivery-card driver-float" aria-labelledby="driver-float-title">
    <div className="delivery-card-head">
      <h2 id="driver-float-title">Mi sencillo</h2>
      <button type="button" onClick={() => void refresh()} disabled={saving}>Actualizar</button>
    </div>
    {loading ? <p>Consultando sencillo…</p> : !day ?
      <p>No hay una jornada de Caja abierta. Podrás declarar tu sencillo cuando el mostrador abra Caja.</p> : <>
        <p className="delivery-subtitle">Jornada: {businessDate(day.business_date)}</p>
        {record ? <>
          <div className="driver-float-total"><span>Sencillo declarado</span><strong>{formatMoney(record.amount_cents)}</strong></div>
          <p className="delivery-subtitle">Ya registraste tu sencillo para esta jornada. No es una venta ni una liquidación.</p>
        </> : <>
          <label className="driver-float-label" htmlFor="driver-float-amount">¿Cuánto sencillo llevás? (Q)</label>
          <input id="driver-float-amount" type="text" inputMode="decimal" placeholder="Ej. 100.00"
            value={amount} onChange={e => setAmount(e.target.value)} disabled={saving} />
          <button type="button" className="delivery-primary" onClick={() => void declareFloat()} disabled={saving}>
            {saving ? 'Registrando…' : 'Registrar sencillo'}
          </button>
          <p className="delivery-subtitle">Se registra una vez por jornada. Al liquidar, Administración revisará el sencillo que te entregó Caja.</p>
        </>}
      </>}
    {error && <p className="delivery-error" role="alert">{error}</p>}
    {message && <p className="delivery-success" role="status">{message}</p>}
    <p className="delivery-subtitle">Declarar el sencillo no registra una venta. La salida de Caja se revisa una sola vez en tu liquidación.</p>
  </section>;
}
