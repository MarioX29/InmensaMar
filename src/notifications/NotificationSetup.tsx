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
      // Do not overwrite subscriptions belonging to another account: the endpoint is globally unique.
      const { data: existing, error: readError } = await supabase.from('push_subscriptions').select('id').eq('endpoint', subscription.endpoint).maybeSingle();
      if (readError) throw readError;
      const payload = { user_id: user.id, endpoint: subscription.endpoint, p256dh: json.keys.p256dh, auth_key: json.keys.auth, updated_at: new Date().toISOString() };
      const result = existing
        ? await supabase.from('push_subscriptions').update(payload).eq('id', existing.id)
        : await supabase.from('push_subscriptions').insert(payload);
      if (result.error) throw result.error;
      setRegistered(true);
      setMessage('Dispositivo registrado para recibir push. Falta configurar el envío remoto.');
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
      {status === 'granted' && <p>{registered ? 'Dispositivo registrado para push.' : 'Permiso concedido. Registrá este dispositivo para push.'}</p>}
      {(status === 'default' || status === 'granted') && <button type="button" className="notification-action" disabled={busy} onClick={() => void enable()}>{busy ? 'Registrando…' : registered ? 'Volver a registrar dispositivo' : 'Activar y registrar dispositivo'}</button>}
      {status === 'granted' && registered && <button type="button" className="notification-action" disabled={busy} onClick={() => void remoteTest()}>Probar push remota</button>}
      {status === 'granted' && <button type="button" className="notification-action" disabled={busy} onClick={() => void test()}>Probar aviso local</button>}
      {message && <p role="status">{message}</p>}
      <small>Prueba remota: solo a tus dispositivos. Los avisos automáticos de pedidos siguen pendientes.</small>
    </section>}
  </div>;
}
