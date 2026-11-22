import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/api/staff.js';

const adminId = 'd1b7686c-91cd-49c8-a8aa-887b5c6fce6b';
const otherId = 'ca9b8785-c1c9-4e32-803a-8ae6b049df56';
const cfg = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key-which-is-long-enough' };

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function installFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

function request(method, body, userId = adminId) {
  return new Request('https://app.example.com/api/staff', {
    method,
    headers: {
      Origin: 'https://app.example.com',
      Authorization: `Bearer token-${userId}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

test('GET solo devuelve personal a un administrador activo', async () => {
  const restore = installFetch(async url => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: adminId, email: 'admin@example.com' });
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.get('user_id') === `eq.${adminId}`) {
      return response([{ user_id: adminId, display_name: 'Admin', role: 'admin', active: true }]);
    }
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.has('order')) {
      return response([
        { user_id: adminId, display_name: 'Admin', role: 'admin', active: true, created_at: '2026-01-01T00:00:00Z' },
        { user_id: otherId, display_name: 'Reparto', role: 'driver', active: false, created_at: '2026-01-02T00:00:00Z' }
      ]);
    }
    if (u.pathname === '/auth/v1/admin/users') return response({ users: [
      { id: adminId, email: 'admin@example.com' }, { id: otherId, email: 'driver@example.com' }
    ], next_page: null });
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const result = await onRequest({ request: request('GET'), env: cfg });
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.equal(data.staff.length, 2);
    assert.equal(data.staff[1].email, 'driver@example.com');
    assert.equal(data.staff[1].active, false);
  } finally { restore(); }
});

test('GET bloquea a un usuario de mostrador', async () => {
  const restore = installFetch(async url => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: otherId });
    if (u.pathname === '/rest/v1/staff_profiles') return response([{ user_id: otherId, display_name: 'Mostrador', role: 'counter', active: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const result = await onRequest({ request: request('GET', undefined, otherId), env: cfg });
    assert.equal(result.status, 403);
    assert.equal((await result.json()).code, 'ADMIN_REQUIRED');
  } finally { restore(); }
});

test('POST crea cuenta y perfil con contraseña temporal que obliga a cambiarla', async () => {
  let createdAuth = null;
  let createdProfile = null;
  const restore = installFetch(async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: adminId });
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.get('user_id') === `eq.${adminId}`) {
      return response([{ user_id: adminId, display_name: 'Admin', role: 'admin', active: true }]);
    }
    if (u.pathname === '/auth/v1/admin/users' && options.method === 'POST') {
      createdAuth = JSON.parse(options.body);
      return response({ id: otherId, email: createdAuth.email }, 201);
    }
    if (u.pathname === '/rest/v1/staff_profiles' && options.method === 'POST') {
      createdProfile = JSON.parse(options.body);
      return new Response(null, { status: 201 });
    }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const result = await onRequest({ request: request('POST', { email: 'Nuevo@Example.com', display_name: 'Nuevo personal', role: 'counter' }), env: cfg });
    assert.equal(result.status, 201);
    const data = await result.json();
    assert.equal(data.staff.email, 'nuevo@example.com');
    assert.ok(data.temporary_password.length >= 40);
    assert.equal(createdAuth.email_confirm, true);
    assert.equal(createdAuth.user_metadata.must_change_password, true);
    assert.equal(createdProfile.role, 'counter');
    assert.equal(createdProfile.active, true);
  } finally { restore(); }
});

test('PATCH no permite desactivar al administrador actual', async () => {
  const restore = installFetch(async url => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: adminId });
    if (u.pathname === '/rest/v1/staff_profiles') return response([{ user_id: adminId, display_name: 'Admin', role: 'admin', active: true }]);
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const result = await onRequest({ request: request('PATCH', { user_id: adminId, display_name: 'Admin', role: 'counter', active: false }), env: cfg });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, 'SELF_LOCKOUT');
  } finally { restore(); }
});

test('PATCH conserva el último administrador activo', async () => {
  const restore = installFetch(async (url, options = {}) => {
    const u = new URL(url);
    if (u.pathname === '/auth/v1/user') return response({ id: adminId });
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.get('user_id') === `eq.${adminId}`) {
      return response([{ user_id: adminId, display_name: 'Admin', role: 'admin', active: true }]);
    }
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.get('user_id') === `eq.${otherId}`) {
      return response([{ user_id: otherId, display_name: 'Other admin', role: 'admin', active: true }]);
    }
    if (u.pathname === '/rest/v1/staff_profiles' && u.searchParams.get('role') === 'eq.admin') {
      return response([{ user_id: otherId }]);
    }
    throw new Error(`Unexpected request ${url}`);
  });
  try {
    const result = await onRequest({ request: request('PATCH', { user_id: otherId, display_name: 'Other admin', role: 'counter', active: true }), env: cfg });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).code, 'LAST_ADMIN');
  } finally { restore(); }
});
