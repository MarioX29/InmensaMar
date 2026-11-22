const allowedRoles = new Set(['admin', 'counter', 'driver']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    }
  });
}

function config(env) {
  const base = typeof env.SUPABASE_URL === 'string' ? env.SUPABASE_URL.replace(/\/$/, '') : '';
  const key = typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' ? env.SUPABASE_SERVICE_ROLE_KEY : '';
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(base) || key.length < 20) return null;
  return { base, key };
}

function headers(key, bearer = key, extra = {}) {
  return {
    apikey: key,
    authorization: `Bearer ${bearer}`,
    'content-type': 'application/json',
    ...extra
  };
}

async function supabaseJson(url, key, bearer, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: headers(key, bearer, options.headers || {})
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* Empty or non-JSON response. */ }
  return { response, payload };
}

async function authenticateAdmin(request, cfg) {
  const auth = request.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return { error: json({ code: 'AUTH_REQUIRED', message: 'Iniciá sesión nuevamente.' }, 401) };
  const userToken = match[1];
  const { response: userResponse, payload: user } = await supabaseJson(
    `${cfg.base}/auth/v1/user`, cfg.key, userToken
  );
  if (!userResponse.ok || !user?.id || !uuidPattern.test(user.id)) {
    return { error: json({ code: 'INVALID_SESSION', message: 'La sesión no es válida. Iniciá sesión nuevamente.' }, 401) };
  }
  const query = new URLSearchParams({
    select: 'user_id,display_name,role,active',
    user_id: `eq.${user.id}`,
    limit: '1'
  });
  const { response: profileResponse, payload: profiles } = await supabaseJson(
    `${cfg.base}/rest/v1/staff_profiles?${query}`, cfg.key
  );
  const profile = Array.isArray(profiles) ? profiles[0] : null;
  if (!profileResponse.ok || !profile || profile.active !== true || profile.role !== 'admin') {
    return { error: json({ code: 'ADMIN_REQUIRED', message: 'Solo un administrador activo puede gestionar el personal.' }, 403) };
  }
  return { userId: user.id, profile };
}

async function listAuthUsers(cfg) {
  const users = [];
  for (let page = 1; page <= 10; page++) {
    const query = new URLSearchParams({ page: String(page), per_page: '1000' });
    const { response, payload } = await supabaseJson(
      `${cfg.base}/auth/v1/admin/users?${query}`, cfg.key
    );
    if (!response.ok || !Array.isArray(payload?.users)) throw new Error('AUTH_USER_LIST_FAILED');
    users.push(...payload.users);
    if (!payload.next_page || payload.next_page === page || payload.users.length < 1000) break;
  }
  return users;
}

async function listStaff(cfg) {
  const query = new URLSearchParams({
    select: 'user_id,display_name,role,active,created_at',
    order: 'created_at.desc'
  });
  const [profileResult, authUsers] = await Promise.all([
    supabaseJson(`${cfg.base}/rest/v1/staff_profiles?${query}`, cfg.key),
    listAuthUsers(cfg)
  ]);
  if (!profileResult.response.ok || !Array.isArray(profileResult.payload)) throw new Error('STAFF_LIST_FAILED');
  const byId = new Map(authUsers.map(user => [user.id, user]));
  return profileResult.payload.map(profile => ({
    user_id: profile.user_id,
    email: byId.get(profile.user_id)?.email || '',
    display_name: profile.display_name,
    role: profile.role,
    active: profile.active,
    created_at: profile.created_at
  }));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return null;
  const raw = await request.text();
  if (raw.length > 8192) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function temporaryPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function createStaff(request, cfg) {
  const body = await readBody(request);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
  const role = body?.role;
  if (!emailPattern.test(email) || email.length > 254 || displayName.length < 1 || displayName.length > 120 || !allowedRoles.has(role)) {
    return json({ code: 'INVALID_INPUT', message: 'Revisá el correo, nombre y rol seleccionados.' }, 400);
  }

  // An administrator provisions the account and hands over this one-time password privately.
  // The AuthGate forces the employee to replace it on first sign-in.
  const initialPassword = temporaryPassword();
  const { response: authResponse, payload: created } = await supabaseJson(
    `${cfg.base}/auth/v1/admin/users`, cfg.key, cfg.key,
    {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: initialPassword,
        email_confirm: true,
        user_metadata: { display_name: displayName, must_change_password: true }
      })
    }
  );
  if (!authResponse.ok || !created?.id) {
    const duplicate = authResponse.status === 422 || /already|registered|exists/i.test(String(created?.msg || created?.message || ''));
    return json({
      code: duplicate ? 'EMAIL_EXISTS' : 'USER_CREATE_FAILED',
      message: duplicate ? 'Ese correo ya tiene una cuenta en Supabase Auth.' : 'No se pudo crear la cuenta de acceso.'
    }, duplicate ? 409 : 502);
  }

  const profile = { user_id: created.id, display_name: displayName, role, active: true };
  const { response: insertResponse } = await supabaseJson(
    `${cfg.base}/rest/v1/staff_profiles`, cfg.key, cfg.key,
    { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(profile) }
  );
  if (!insertResponse.ok) {
    await supabaseJson(`${cfg.base}/auth/v1/admin/users/${created.id}`, cfg.key, cfg.key, { method: 'DELETE' });
    return json({ code: 'PROFILE_CREATE_FAILED', message: 'No se pudo crear el perfil del personal. Se intentó revertir la cuenta de Auth; verificá el listado antes de repetir.' }, 502);
  }
  return json({
    staff: { user_id: created.id, email, display_name: displayName, role, active: true },
    temporary_password: initialPassword,
    message: 'Cuenta creada. Copiá la contraseña temporal y entregásela directamente a la persona; solo se mostrará una vez.'
  }, 201);
}

async function updateStaff(request, cfg, callerId) {
  const body = await readBody(request);
  const userId = typeof body?.user_id === 'string' ? body.user_id : '';
  const displayName = typeof body?.display_name === 'string' ? body.display_name.trim() : '';
  const role = body?.role;
  const active = body?.active;
  if (!uuidPattern.test(userId) || displayName.length < 1 || displayName.length > 120 || !allowedRoles.has(role) || typeof active !== 'boolean') {
    return json({ code: 'INVALID_INPUT', message: 'Los datos del usuario no son válidos.' }, 400);
  }
  if (userId === callerId && (role !== 'admin' || active !== true)) {
    return json({ code: 'SELF_LOCKOUT', message: 'No podés quitarte el rol de administrador ni desactivar tu propia cuenta.' }, 409);
  }

  const currentQuery = new URLSearchParams({
    select: 'user_id,display_name,role,active',
    user_id: `eq.${userId}`,
    limit: '1'
  });
  const { response: currentResponse, payload: currentRows } = await supabaseJson(
    `${cfg.base}/rest/v1/staff_profiles?${currentQuery}`, cfg.key
  );
  if (!currentResponse.ok || !Array.isArray(currentRows) || !currentRows[0]) {
    return json({ code: 'STAFF_NOT_FOUND', message: 'No se encontró ese perfil de personal.' }, 404);
  }
  const current = currentRows[0];
  if (current.role === 'admin' && current.active && (role !== 'admin' || !active)) {
    const adminQuery = new URLSearchParams({ select: 'user_id', role: 'eq.admin', active: 'eq.true' });
    const { response: adminsResponse, payload: admins } = await supabaseJson(
      `${cfg.base}/rest/v1/staff_profiles?${adminQuery}`, cfg.key
    );
    if (!adminsResponse.ok || !Array.isArray(admins) || admins.length <= 1) {
      return json({ code: 'LAST_ADMIN', message: 'Debe quedar al menos un administrador activo.' }, 409);
    }
  }

  const updateQuery = new URLSearchParams({ user_id: `eq.${userId}` });
  const { response: updateResponse, payload: updated } = await supabaseJson(
    `${cfg.base}/rest/v1/staff_profiles?${updateQuery}`, cfg.key, cfg.key,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ display_name: displayName, role, active }) }
  );
  if (!updateResponse.ok) return json({ code: 'UPDATE_FAILED', message: 'No se pudieron guardar los cambios del usuario.' }, 502);
  return json({ staff: Array.isArray(updated) ? updated[0] : null, message: 'Datos del personal actualizados.' });
}

export async function onRequest({ request, env }) {
  const cfg = config(env);
  if (!cfg) return json({ code: 'SERVER_CONFIG', message: 'La administración de personal no está configurada en el servidor.' }, 503);

  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ code: 'FORBIDDEN', message: 'Solicitud no permitida.' }, 403);
  }
  if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
    return json({ code: 'METHOD_NOT_ALLOWED' }, 405);
  }
  if (request.method !== 'GET' && !origin) {
    return json({ code: 'FORBIDDEN', message: 'Falta validar el origen de la solicitud.' }, 403);
  }

  try {
    const admin = await authenticateAdmin(request, cfg);
    if (admin.error) return admin.error;
    if (request.method === 'GET') return json({ staff: await listStaff(cfg) });
    if (request.method === 'POST') return await createStaff(request, cfg);
    return await updateStaff(request, cfg, admin.userId);
  } catch (error) {
    console.error('Staff administration failed', error instanceof Error ? error.message : 'unknown');
    return json({ code: 'STAFF_SERVICE_ERROR', message: 'No se pudo completar la operación de personal. Intentá nuevamente.' }, 502);
  }
}
