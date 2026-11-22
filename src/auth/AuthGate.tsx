import { cloneElement, isValidElement, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type Staff = { display_name: string; role: 'admin' | 'counter' | 'driver'; active: boolean };
type AuthState = { status: 'loading' | 'signed_out' | 'password_setup' | 'authorized' | 'denied'; staff?: Staff; userId?: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    let revision = 0;
    async function resolve(session: Session | null) {
      const current = ++revision;
      if (!session) {
        if (alive && current === revision) setAuth({ status: 'signed_out' });
        return;
      }
      if (session.user.user_metadata?.must_change_password === true) {
        if (alive && current === revision) setAuth({ status: 'password_setup', userId: session.user.id });
        return;
      }
      if (alive) setAuth({ status: 'loading' });
      const { data, error: profileError } = await supabase!
        .from('staff_profiles')
        .select('display_name, role, active')
        .eq('user_id', session.user.id)
        .maybeSingle();
      if (!alive || current !== revision) return;
      if (profileError || !data || !data.active || !['admin', 'counter', 'driver'].includes(data.role)) {
        setAuth({ status: 'denied' });
      } else {
        setAuth({ status: 'authorized', staff: data as Staff, userId: session.user.id });
      }
    }
    supabase.auth.getSession().then(({ data }) => resolve(data.session)).catch(() => {
      if (alive) setAuth({ status: 'denied' });
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      // Defer profile reads until the authentication callback has finished.
      setTimeout(() => { if (alive) void resolve(session); }, 0);
    });
    return () => { alive = false; revision++; listener.subscription.unsubscribe(); };
  }, []);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    setError('');
    setBusy(true);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (signInError) setError('No se pudo iniciar sesión. Revisá tus credenciales.');
    setPassword('');
  }

  async function setFirstPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || busy) return;
    setError('');
    if (newPassword.length < 12) { setError('Usá al menos 12 caracteres para tu nueva contraseña.'); return; }
    if (newPassword !== confirmPassword) { setError('Las contraseñas no coinciden.'); return; }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
      data: { must_change_password: false }
    });
    if (updateError) {
      setError('No se pudo guardar tu contraseña. Revisá la conexión e intentá nuevamente.');
      setBusy(false);
      return;
    }
    setNewPassword(''); setConfirmPassword('');
    setAuth({ status: 'loading' });
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData.session;
    if (!session) { setAuth({ status: 'signed_out' }); setBusy(false); return; }
    const { data: profile, error: profileError } = await supabase
      .from('staff_profiles')
      .select('display_name, role, active')
      .eq('user_id', session.user.id)
      .maybeSingle();
    if (profileError || !profile || !profile.active || !['admin', 'counter', 'driver'].includes(profile.role)) {
      setAuth({ status: 'denied' });
    } else {
      setAuth({ status: 'authorized', staff: profile as Staff, userId: session.user.id });
    }
    setBusy(false);
  }

  async function signOut() {
    if (!supabase) return;
    setError('');
    // Revoke this installation's push subscription before switching accounts.
    // Only remove rows owned by the currently authenticated user (RLS).
    try {
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const { data: { user } } = await supabase.auth.getUser();
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (user && subscription) {
          const { error: deleteError } = await supabase.from('push_subscriptions')
            .delete().eq('user_id', user.id).eq('endpoint', subscription.endpoint);
          if (deleteError) throw deleteError;
          await subscription.unsubscribe();
        }
      }
    } catch {
      setError('No se pudo desvincular las notificaciones. Revisá la conexión e intentá de nuevo.');
      return;
    }
    const { error: signOutError } = await supabase.auth.signOut();
    if (signOutError) setError('No se pudo cerrar sesión. Intentá nuevamente.');
  }

  if (!supabase) return <main className="auth-screen"><section className="auth-card">
    <h1>Inmensa Mar</h1><p>Falta configurar la conexión con Supabase.</p>
    <p className="auth-hint">Definí VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY en el entorno de despliegue.</p>
  </section></main>;
  if (auth.status === 'loading') return <main className="auth-screen"><p>Verificando acceso…</p></main>;
  if (auth.status === 'signed_out') return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand"><img src="/logo-inmensa-mar.jpg" alt="Logo de Inmensa-Mar Xela" width="72" height="72"/><strong>Inmensa Mar</strong></div><h1>Ingresar al negocio</h1><p>Usá tu cuenta de personal.</p>
    <form onSubmit={signIn} className="auth-form">
      <label htmlFor="login-email">Correo electrónico</label>
      <input id="login-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      <label htmlFor="login-password">Contraseña</label>
      <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Ingresando…' : 'Iniciar sesión'}</button>
    </form>
  </section></main>;
  if (auth.status === 'password_setup') return <main className="auth-screen"><section className="auth-card">
    <div className="auth-brand"><img src="/logo-inmensa-mar.jpg" alt="Logo de Inmensa-Mar Xela" width="72" height="72"/><strong>Inmensa Mar</strong></div>
    <h1>Creá tu contraseña</h1><p>Esta es tu primera entrada. Reemplazá la contraseña temporal por una personal que solo vos conozcás.</p>
    <form onSubmit={setFirstPassword} className="auth-form">
      <label htmlFor="new-password">Nueva contraseña</label>
      <input id="new-password" type="password" autoComplete="new-password" minLength={12} required value={newPassword} onChange={e => setNewPassword(e.target.value)} />
      <label htmlFor="confirm-password">Confirmar contraseña</label>
      <input id="confirm-password" type="password" autoComplete="new-password" minLength={12} required value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar contraseña'}</button>
      <button type="button" className="auth-signout" onClick={signOut}>Cerrar sesión</button>
    </form>
  </section></main>;
  if (auth.status === 'denied') return <main className="auth-screen"><section className="auth-card">
    <h1>Acceso no autorizado</h1><p>Esta cuenta no tiene un perfil activo de personal.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary" onClick={signOut}>Cerrar sesión</button>
  </section></main>;
  return <><div className="session-strip"><span>{auth.staff?.display_name} · {auth.staff?.role==='admin'?'Administración':auth.staff?.role==='driver'?'Reparto':'Mostrador'}</span><button onClick={signOut}>Cerrar sesión</button></div>{isValidElement<{ staffRole?: Staff['role'];userId?:string }>(children) ? cloneElement(children, {staffRole:auth.staff?.role, userId:auth.userId, key:auth.userId}) : children}</>;
}
