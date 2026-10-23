import { cloneElement, isValidElement, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';

type Staff = { display_name: string; role: 'admin' | 'counter' | 'driver'; active: boolean };
type AuthState = { status: 'loading' | 'signed_out' | 'authorized' | 'denied'; staff?: Staff; userId?: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
    <h1>Inmensa Mar</h1><p>Ingresá con tu cuenta de personal.</p>
    <form onSubmit={signIn} className="auth-form">
      <label htmlFor="login-email">Correo electrónico</label>
      <input id="login-email" type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} />
      <label htmlFor="login-password">Contraseña</label>
      <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} />
      {error && <p className="auth-error" role="alert">{error}</p>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Ingresando…' : 'Iniciar sesión'}</button>
    </form>
  </section></main>;
  if (auth.status === 'denied') return <main className="auth-screen"><section className="auth-card">
    <h1>Acceso no autorizado</h1><p>Esta cuenta no tiene un perfil activo de personal.</p>
    {error && <p className="auth-error" role="alert">{error}</p>}
    <button className="primary" onClick={signOut}>Cerrar sesión</button>
  </section></main>;
  return <><div className="session-strip"><span>{auth.staff?.display_name} · {auth.staff?.role}</span><button onClick={signOut}>Cerrar sesión</button></div>{isValidElement<{ staffRole?: Staff['role'];userId?:string }>(children) ? cloneElement(children, {staffRole:auth.staff?.role, userId:auth.userId, key:auth.userId}) : children}</>;
}
