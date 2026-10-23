import { useEffect, useRef, useState } from 'react';
import { Bell, BellRing, X } from 'lucide-react';
import './notifications.css';
type Status = 'checking' | 'unsupported' | 'install' | NotificationPermission;
function check(): Status {
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) return 'unsupported';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const installed = window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (ios && !installed) return 'install';
  return Notification.permission;
}
export function NotificationSetup() {
  const [status, setStatus] = useState<Status>('checking');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  async function enable() {
    setBusy(true); setMessage('');
    try { const permission = await Notification.requestPermission(); setStatus(permission); if (permission === 'granted') setMessage('Permiso activado. El envío remoto se configurará después.'); }
    catch { setMessage('No se pudo solicitar el permiso.'); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMessage('');
    try { const sw = await navigator.serviceWorker.ready; await sw.showNotification('Inmensa Mar · Prueba', { body: 'Aviso local funcionando.', icon: '/icon-192.png', tag: 'inmensa-local-test' }); setMessage('Aviso local enviado. Esto no prueba push remota.'); }
    catch { setMessage('No se pudo mostrar el aviso local.'); }
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
      {status === 'default' && <><p>Activá las notificaciones en este dispositivo.</p><button type="button" className="notification-action" disabled={busy} onClick={() => void enable()}>Activar notificaciones</button></>}
      {status === 'denied' && <p>Notificaciones bloqueadas. Revisá los permisos del dispositivo.</p>}
      {status === 'granted' && <><p>Permiso concedido.</p><button type="button" className="notification-action" disabled={busy} onClick={() => void test()}>Probar aviso local</button></>}
      {message && <p role="status">{message}</p>}
      <small>Los avisos remotos de pedidos se conectarán en la siguiente etapa.</small>
    </section>}
  </div>;
}
