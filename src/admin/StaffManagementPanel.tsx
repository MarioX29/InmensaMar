import { FormEvent, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './staff.css';

type StaffRole = 'admin' | 'counter' | 'driver';
type StaffMember = {
  user_id: string;
  email: string;
  display_name: string;
  role: StaffRole;
  active: boolean;
  created_at?: string;
};
type InviteResult = { message: string; temporary_password: string };

const roleLabels: Record<StaffRole, string> = {
  admin: 'Administrador',
  counter: 'Mostrador',
  driver: 'Repartidor'
};

async function staffRequest<T>(method: 'GET' | 'POST' | 'PATCH', body?: unknown): Promise<T> {
  if (!supabase) throw new Error('No hay conexión con Supabase.');
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Tu sesión venció. Iniciá sesión nuevamente.');
  const response = await fetch('/api/staff', {
    method,
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });
  let payload: any = {};
  try { payload = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(payload.message || 'No se pudo completar la operación.');
  return payload as T;
}

export function StaffManagementPanel() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<StaffRole>('counter');
  const [temporaryPassword, setTemporaryPassword] = useState('');
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ display_name: string; role: StaffRole; active: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await staffRequest<{ staff: StaffMember[] }>('GET');
      setStaff(result.staff);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el personal.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setError(''); setNotice(''); setTemporaryPassword(''); setCopied(false);
    try {
      const result = await staffRequest<InviteResult>('POST', {
        email: email.trim().toLowerCase(),
        display_name: displayName.trim(),
        role
      });
      setNotice(result.message);
      setTemporaryPassword(result.temporary_password);
      setEmail(''); setDisplayName(''); setRole('counter'); setShowInvite(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la cuenta.');
    } finally { setSaving(false); }
  }

  function startEdit(person: StaffMember) {
    setEditing(person.user_id);
    setDraft({ display_name: person.display_name, role: person.role, active: person.active });
    setError(''); setNotice(''); setTemporaryPassword('');
  }

  async function saveEdit(person: StaffMember) {
    if (!draft || saving) return;
    if (!window.confirm(`¿Guardar los cambios de ${person.display_name}?`)) return;
    setSaving(true); setError(''); setNotice('');
    try {
      const result = await staffRequest<{ message: string }>('PATCH', { user_id: person.user_id, ...draft });
      setNotice(result.message); setEditing(null); setDraft(null); await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudieron guardar los cambios.');
    } finally { setSaving(false); }
  }

  function cancelEdit() { setEditing(null); setDraft(null); }
  async function copyPassword() {
    if (!temporaryPassword) return;
    try { await navigator.clipboard.writeText(temporaryPassword); setCopied(true); }
    catch { setError('No se pudo copiar. Seleccioná la contraseña y copiala manualmente.'); }
  }

  return <section className="staff-management">
    <header className="staff-heading">
      <div><h2>Personal</h2><p>Agregá personas al equipo y definí a qué partes del sistema pueden ingresar.</p></div>
      <button type="button" className="staff-primary" onClick={() => { setShowInvite(v => !v); setError(''); setNotice(''); setTemporaryPassword(''); }}>
        {showInvite ? 'Cerrar' : 'Agregar persona'}
      </button>
    </header>

    {notice && <p className="staff-notice" role="status">{notice}</p>}
    {error && <p className="staff-error" role="alert">{error}</p>}

    {temporaryPassword && <section className="staff-credential" aria-label="Contraseña temporal creada">
      <strong>Contraseña temporal</strong>
      <p>Entregásela directamente a esta persona. No se volverá a mostrar cuando salgas de esta pantalla.</p>
      <code>{temporaryPassword}</code>
      <button type="button" className="staff-primary" onClick={() => void copyPassword()}>{copied ? 'Copiada' : 'Copiar contraseña'}</button>
      <small>En su primer ingreso deberá crear una contraseña personal.</small>
    </section>}

    {showInvite && <form className="staff-invite" onSubmit={create}>
      <div><h3>Agregar al equipo</h3><p>Se crea una cuenta y una contraseña temporal de un solo uso.</p></div>
      <label>Nombre completo<input value={displayName} onChange={e => setDisplayName(e.target.value)} maxLength={120} autoComplete="name" required /></label>
      <label>Correo electrónico<input type="email" value={email} onChange={e => setEmail(e.target.value)} maxLength={254} autoComplete="email" required /></label>
      <label>Rol<select value={role} onChange={e => setRole(e.target.value as StaffRole)}>
        <option value="counter">Mostrador</option><option value="driver">Repartidor</option><option value="admin">Administrador</option>
      </select></label>
      <button className="staff-primary" type="submit" disabled={saving}>{saving ? 'Creando cuenta…' : 'Crear cuenta'}</button>
      <small>La cuenta queda activa. La contraseña temporal se muestra una sola vez; compartila por un medio privado.</small>
    </form>}

    <div className="staff-list-head"><h3>Personas registradas</h3><span>{staff.length} {staff.length === 1 ? 'persona' : 'personas'}</span></div>
    {loading ? <p className="staff-empty">Cargando personal…</p> : staff.length === 0 ? <p className="staff-empty">Todavía no hay perfiles de personal.</p> : <div className="staff-list">
      {staff.map(person => <article className="staff-person" key={person.user_id}>
        {editing === person.user_id && draft ? <div className="staff-edit-form">
          <label>Nombre<input value={draft.display_name} onChange={e => setDraft({ ...draft, display_name: e.target.value })} maxLength={120} required /></label>
          <label>Rol<select value={draft.role} onChange={e => setDraft({ ...draft, role: e.target.value as StaffRole })}>
            <option value="admin">Administrador</option><option value="counter">Mostrador</option><option value="driver">Repartidor</option>
          </select></label>
          <label className="staff-active-toggle"><input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} /> Cuenta activa</label>
          <div className="staff-actions"><button type="button" className="staff-primary" disabled={saving} onClick={() => void saveEdit(person)}>Guardar cambios</button><button type="button" className="staff-secondary" disabled={saving} onClick={cancelEdit}>Cancelar</button></div>
        </div> : <>
          <div className="staff-person-main"><strong>{person.display_name}</strong><span>{person.email || 'Correo no disponible'}</span><small>{roleLabels[person.role]}</small></div>
          <div className="staff-person-side"><span className={person.active ? 'staff-status is-active' : 'staff-status is-inactive'}>{person.active ? 'Activo' : 'Inactivo'}</span><button type="button" className="staff-secondary" onClick={() => startEdit(person)}>Editar</button></div>
        </>}
      </article>)}
    </div>}
    <aside className="staff-guidance"><strong>Control de accesos</strong><p>Desactivar una cuenta bloquea su acceso operativo, pero conserva sus ventas, entregas y movimientos históricos. Debe quedar al menos un administrador activo. El administrador que está usando esta pantalla no puede desactivar su propia cuenta.</p></aside>
  </section>;
}
