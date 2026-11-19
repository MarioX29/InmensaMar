import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from './push-test.js';

const env = {
  SUPABASE_URL: 'https://inmensamar-test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'server-only-test-key',
  VAPID_PUBLIC_KEY: 'placeholder-public-key',
  VAPID_PRIVATE_KEY: 'placeholder-private-key'
};

function request() {
  return new Request('https://inmensamar.example/api/push-test', {
    method: 'POST',
    headers: { authorization: 'Bearer test-user-token' }
  });
}

async function withFetchMock(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('rejects a valid Supabase account without an active staff profile', async () => {
  let subscriptionLookupCalled = false;

  await withFetchMock(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'user-1' });
    if (url.pathname === '/rest/v1/staff_profiles') return jsonResponse([]);
    if (url.pathname === '/rest/v1/push_subscriptions') subscriptionLookupCalled = true;
    throw new Error(`Unexpected request: ${url.pathname}`);
  }, async () => {
    const response = await onRequestPost({ request: request(), env });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Active staff access required' });
    assert.equal(subscriptionLookupCalled, false);
  });
});

test('rejects inactive staff profiles', async () => {
  let subscriptionLookupCalled = false;

  await withFetchMock(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'user-2' });
    if (url.pathname === '/rest/v1/staff_profiles') {
      // The active=true query should exclude this profile in PostgREST.
      assert.equal(url.searchParams.get('active'), 'eq.true');
      return jsonResponse([]);
    }
    if (url.pathname === '/rest/v1/push_subscriptions') subscriptionLookupCalled = true;
    throw new Error(`Unexpected request: ${url.pathname}`);
  }, async () => {
    const response = await onRequestPost({ request: request(), env });
    assert.equal(response.status, 403);
    assert.equal(subscriptionLookupCalled, false);
  });
});

test('allows an active staff role to continue to its own subscription lookup', async () => {
  let subscriptionLookupCalled = false;

  await withFetchMock(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'user-3' });
    if (url.pathname === '/rest/v1/staff_profiles') {
      assert.equal(url.searchParams.get('user_id'), 'eq.user-3');
      assert.equal(url.searchParams.get('active'), 'eq.true');
      return jsonResponse([{ user_id: 'user-3', role: 'driver', active: true }]);
    }
    if (url.pathname === '/rest/v1/push_subscriptions') {
      subscriptionLookupCalled = true;
      assert.equal(url.searchParams.get('user_id'), 'eq.user-3');
      return jsonResponse([]);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }, async () => {
    const response = await onRequestPost({ request: request(), env });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'No registered devices' });
    assert.equal(subscriptionLookupCalled, true);
  });
});

test('does not continue when staff eligibility cannot be verified', async () => {
  let subscriptionLookupCalled = false;

  await withFetchMock(async (input) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return jsonResponse({ id: 'user-4' });
    if (url.pathname === '/rest/v1/staff_profiles') return jsonResponse({ message: 'database unavailable' }, 500);
    if (url.pathname === '/rest/v1/push_subscriptions') subscriptionLookupCalled = true;
    throw new Error(`Unexpected request: ${url.pathname}`);
  }, async () => {
    const response = await onRequestPost({ request: request(), env });
    assert.equal(response.status, 503);
    assert.equal(subscriptionLookupCalled, false);
  });
});
