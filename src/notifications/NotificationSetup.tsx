import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import './notifications.css';

type Status = 'checking' | 'unsupported' | 'install' | NotificationPermission;
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY?.trim() || '';

function check(): Status {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !installed) return 'install';
  return Notification.permission;
}
function decodeVapid(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function NotificationSetup() {
  const [status, setStatus] = useState<Status>('checking');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [message, setMessage] = useState('');
  const [role, setRole] = useState('');
  const [orderAlerts, setOrderAlerts] = useState(true);
  const [deliveryAlerts, setDeliveryAlerts] = useState(true);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => { setStatus(check()); }, []);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) { if (root.current && !root.current.contains(event.target as Node)) setOpen(false); }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') setOpen(false); }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  useEffect(() => {
    if (!open || status !== 'granted' || !supabase) return;
    let active = true;
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      const sw = await navigator.serviceWorker.ready;
      const subscription = await sw.pushManager.getSubscription();
      if (!user || !subscription) { if (active) setRegistered(false); return; }
      const { data, error } = await supabase.from('push_subscriptions').select('id').eq('user_id', user.id).eq('endpoint', subscription.endpoint).maybeSingle();
      if (active) setRegistered(!error && !!data);
    })().catch(() => { if (active) setRegistered(false); });
    return () => { active = false; };
  }, [open, status]);
  useEffect(() => {
    if (!open || !supabase) return;
    let active = true;
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const [profile, preferences] = await Promise.all([
        supabase.from('staff_profiles').select('role').eq('user_id', user.id).maybeSingle(),
        supabase.from('push_preferences').select('new_orders,deliveries').eq('user_id', user.id).maybeSingle()
      ]);
      if (!active) return;
      if (profile.error || preferences.error) {
        setMessage('No se pudieron consultar las preferencias.');
        return;
      }
      setRole(profile.data?.role || '');
      setOrderAlerts(preferences.data?.new_orders ?? true);
      setDeliveryAlerts(preferences.data?.deliveries ?? true);
    })().catch(() => { if (active) setMessage('No se pudieron consultar las preferencias.'); });
    return () => { active = false; };
  }, [open]);
  async function savePreference(field: 'new_orders' | 'deliveries', value: boolean) {
    if (!supabase || savingPrefs) return;
    setSavingPrefs(true);
    setMessage('');
    try {
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error('Iniciá sesión nuevamente.');
      const { error } = await supabase.from('push_preferences').upsert({ user_id: user.id, [field]: value, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throw error;
      if (field === 'new_orders') setOrderAlerts(value);
      else setDeliveryAlerts(value);
      setMessage('Preferencia guardada.');
    } catch { setMessage('No se pudo guardar la preferencia.'); }
    finally { setSavingPrefs(false); }
  }
  async function enable() {
    setBusy(true); setMessage('');
    try {
      const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      setStatus(permission);
      if (permission !== 'granted') { setMessage('No se concedió el permiso.'); return; }
      if (!supabase) throw new Error('No hay conexión configurada con Supabase.');
      if (!vapidPublicKey) throw new Error('Falta configurar VITE_VAPID_PUBLIC_KEY en Cloudflare.');
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) throw new Error('Iniciá sesión nuevamente.');
      const sw = await navigator.serviceWorker.ready;
      const subscription = await sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapid(vapidPublicKey) });
      const json = subscription.toJSON();
      if (!json.keys?.p256dh || !json.keys?.auth) throw new Error('La suscripción no contiene claves válidas.');
      // RLS only exposes the current user's rows. Never update another user's subscription.
      const { data: own, error: ownError } = await supabase.from('push_subscriptions')
        .select('id').eq('user_id', user.id).eq('endpoint', subscription.endpoint).maybeSingle();
      if (ownError) throw ownError;
      const payload = { user_id: user.id, endpoint: subscription.endpoint, p256dh: json.keys.p256dh, auth_key: json.keys.auth, updated_at: new Date().toISOString() };
      let result = own
        ? await supabase.from('push_subscriptions').update(payload).eq('id', own.id)
        : await supabase.from('push_subscriptions').insert(payload);
      if (result.error?.code === '23505' && !own) {
        // Same browser was previously used by a different account. Replace its
        // browser subscription, never transfer another user's DB record.
        await subscription.unsubscribe();
        const fresh = await sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeVapid(vapidPublicKey) });
        const freshJson = fresh.toJSON();
        if (!freshJson.keys?.p256dh || !freshJson.keys?.auth) throw new Error('No se pudo renovar la suscripción.');
        result = await supabase.from('push_subscriptions').insert({
          user_id: user.id, endpoint: fresh.endpoint,
          p256dh: freshJson.keys.p256dh, auth_key: freshJson.keys.auth,
          updated_at: new Date().toISOString()
        });
      }
      if (result.error) {
        if (result.error.code === '23505') throw new Error('Este dispositivo sigue asociado a otra cuenta. Ingresá con la cuenta anterior y cerrá sesión desde la aplicación; luego volvé a intentarlo.');
        throw result.error;
      }
      setRegistered(true);
      setMessage('Dispositivo registrado para recibir push.');
    } catch (error) {
      setRegistered(false);
      setMessage(error instanceof Error ? error.message : 'No se pudo registrar el dispositivo.');
    } finally { setBusy(false); }
  }
  async function remoteTest() {
    setBusy(true); setMessage('');
    try {
      if (!supabase) throw new Error('Supabase no está configurado.');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error('Iniciá sesión nuevamente.');
      const response = await fetch('/api/push-test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` }
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Falló el envío remoto.');
      setMessage(`Enviadas al servicio push: ${result.sent}. Fallidas: ${result.failed}. Revisá tu dispositivo.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo enviar la push remota.');
    } finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMessage('');
    try {
      const sw = await navigator.serviceWorker.ready;
      await sw.showNotification('Inmensa Mar · Prueba', { body: 'Aviso local funcionando.', icon: '/icon-192.png', tag: 'inmensa-local-test' });
      setMessage('Aviso local enviado. Esto no prueba push remota.');
    } catch { setMessage('No se pudo mostrar el aviso local.'); }
    finally { setBusy(false); }
  }
  return <div className="notification-control" ref={root}>
    <button type="button" className="notification-bell" aria-label="Configurar notificaciones" aria-expanded={open} aria-haspopup="dialog" onClick={() => { setOpen(v => !v); setStatus(check()); }}>
      {status === 'granted' ? <BellRing size={21}/> : <Bell size={21}/>}
    </button>
    {open && <section className="notification-popover" role="dialog" aria-label="Notificaciones">
      <div className="notification-popover-head"><strong>Notificaciones</strong><button type="button" className="notification-close" aria-label="Cerrar" onClick={() => setOpen(false)}><X size={18}/></button></div>
      {status === 'checking' && <p>Comprobando dispositivo…</p>}
      {status === 'unsupported' && <p>Este navegador no admite Web Push.</p>}
      {status === 'install' && <p>En iPhone, abrí Inmensa Mar desde el ícono instalado en la pantalla de inicio.</p>}
      {status === 'default' && <p>Activá las notificaciones en este dispositivo.</p>}
      {status === 'denied' && <p>Notificaciones bloqueadas. Revisá los permisos del dispositivo.</p>}
      {status === 'granted' && <p>{registered ? 'Avisos activados en este dispositivo.' : 'Falta registrar este dispositivo para recibir avisos.'}</p>}
      {(status === 'default' || status === 'granted') && <button type="button" className="notification-action" disabled={busy} onClick={() => void enable()}>{busy ? 'Registrando…' : registered ? 'Actualizar este dispositivo' : 'Activar notificaciones'}</button>}
      <details className="notification-tests"><summary>Probar notificaciones</summary>
      {status === 'granted' && registered && <button type="button" className="notification-action" disabled={busy} onClick={() => void remoteTest()}>Enviar aviso de prueba</button>}
      {status === 'granted' && <button type="button" className="notification-action" disabled={busy} onClick={() => void test()}>Probar aviso en este equipo</button>}
      </details>
      {role === 'admin' && <div className="notification-preferences">
        <strong>Qué avisos quiero recibir</strong>
        <label><span>Pedidos nuevos</span><input type="checkbox" checked={orderAlerts} disabled={savingPrefs} onChange={e => void savePreference('new_orders', e.target.checked)}/></label>
        <label><span>Mis entregas asignadas</span><input type="checkbox" checked={deliveryAlerts} disabled={savingPrefs} onChange={e => void savePreference('deliveries', e.target.checked)}/></label>
        <small>Estas opciones se aplican a todos tus dispositivos. No cambian tus permisos.</small>
      </div>}
      {message && <p role="status">{message}</p>}
      <small>Las pruebas se envían solo a tus dispositivos.</small>
    </section>}
  </div>;
}
