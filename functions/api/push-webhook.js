
// Cloudflare Pages Function: authenticated, self-only Web Push QA.
// Secrets are read from context.env; never exposed to the browser.

const enc = new TextEncoder();

const b64u = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const unb64u = (s) =>
  Uint8Array.from(
    atob(
      s.replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(s.length / 4) * 4, '=')
    ),
    (c) => c.charCodeAt(0)
  );

const concat = (...arrays) => {
  const out = new Uint8Array(
    arrays.reduce((n, a) => n + a.length, 0)
  );

  let i = 0;

  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }

  return out;
};

const u32 = (n) =>
  new Uint8Array([
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255
  ]);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

async function hkdf(ikm, salt, info, length) {
  const key = await crypto.subtle.importKey(
    'raw',
    ikm,
    'HKDF',
    false,
    ['deriveBits']
  );

  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info
      },
      key,
      length * 8
    )
  );
}

async function encrypt(subscription, payload) {
  const receiver = unb64u(subscription.p256dh);
  const auth = unb64u(subscription.auth_key);

  if (receiver.length !== 65 || auth.length !== 16) {
    throw Error('Invalid subscription keys');
  }

  const pair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    true,
    ['deriveBits']
  );

  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey('raw', pair.publicKey)
  );

  const clientPublic = await crypto.subtle.importKey(
    'raw',
    receiver,
    {
      name: 'ECDH',
      namedCurve: 'P-256'
    },
    false,
    []
  );

  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: clientPublic
      },
      pair.privateKey,
      256
    )
  );

  const ikm = await hkdf(
    shared,
    auth,
    concat(
      enc.encode('WebPush: info'),
      new Uint8Array([0]),
      receiver,
      serverPublic
    ),
    32
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await hkdf(
    ikm,
    salt,
    enc.encode('Content-Encoding: aes128gcm\0'),
    16
  );

  const nonce = await hkdf(
    ikm,
    salt,
    enc.encode('Content-Encoding: nonce\0'),
    12
  );

  const aes = await crypto.subtle.importKey(
    'raw',
    key,
    'AES-GCM',
    false,
    ['encrypt']
  );

  const message = concat(
    enc.encode(JSON.stringify(payload)),
    new Uint8Array([2])
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: nonce
      },
      aes,
      message
    )
  );

  return concat(
    salt,
    u32(4096),
    new Uint8Array([serverPublic.length]),
    serverPublic,
    ciphertext
  );
}

async function vapidHeaders(endpoint, publicKey, privateKey) {
  const pub = unb64u(publicKey);
  const priv = unb64u(privateKey);

  if (pub.length !== 65 || priv.length !== 32) {
    throw Error('Invalid VAPID key configuration');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      x: b64u(pub.slice(1, 33)),
      y: b64u(pub.slice(33)),
      d: b64u(priv),
      ext: false,
      key_ops: ['sign']
    },
    {
      name: 'ECDSA',
      namedCurve: 'P-256'
    },
    false,
    ['sign']
  );

  const aud = new URL(endpoint).origin;

  const head = b64u(
    enc.encode(JSON.stringify({
      typ: 'JWT',
      alg: 'ES256'
    }))
  );

  const body = b64u(
    enc.encode(JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + 3600,
      sub: 'https://inmensamar.pages.dev'
    }))
  );

  const input = `${head}.${body}`;

  const signature = new Uint8Array(
    await crypto.subtle.sign(
      {
        name: 'ECDSA',
        hash: 'SHA-256'
      },
      key,
      enc.encode(input)
    )
  );

  return `vapid t=${input}.${b64u(signature)}, k=${publicKey}`;
}

function permittedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);

    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      (u.port && u.port !== '443')
    ) {
      return false;
    }

    const h = u.hostname.toLowerCase();

    return (
      h === 'fcm.googleapis.com' ||
      h === 'updates.push.services.mozilla.com' ||
      h === 'push.services.mozilla.com' ||
      h === 'web.push.apple.com' ||
      h.endsWith('.push.apple.com') ||
      h.endsWith('.notify.windows.com') ||
      h === 'wns2-pn1p.notify.windows.com'
    );
  } catch {
    return false;
  }
}

// Supabase Database Webhook -> Cloudflare Pages.
// Requires PUSH_WEBHOOK_SECRET as a Preview secret.
const safeEqual = (a, b) => {
  const x = enc.encode(a || ''), y = enc.encode(b || '');
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] || 0) ^ (y[i] || 0);
  return difference === 0;
};

async function supabaseCall(base, key, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.PUSH_WEBHOOK_SECRET || !env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    return json({ error: 'Server configuration incomplete' }, 503);
  }
  const provided = request.headers.get('x-push-webhook-secret') || '';
  if (!safeEqual(provided, env.PUSH_WEBHOOK_SECRET)) return json({ error: 'Unauthorized' }, 401);
  const base = env.SUPABASE_URL.replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(base)) return json({ error: 'Invalid server configuration' }, 503);
  let incoming;
  try { incoming = await request.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (incoming?.type !== 'INSERT' || incoming?.table !== 'push_events' || !['delivery_assigned', 'customer_order_created'].includes(incoming?.record?.event_type)) {
    return json({ error: 'Unsupported webhook event' }, 400);
  }
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  // Claim is atomic. It may claim other pending events; each is validated against the database.
  const claimed = await supabaseCall(base, key, '/rest/v1/rpc/claim_push_events', {
    method: 'POST', body: JSON.stringify({ p_limit: 10 })
  });
  if (!claimed.ok) {
    console.error('Push claim failed', { status: claimed.status });
    return json({ error: 'Unable to claim events' }, 502);
  }
  const events = await claimed.json();
  if (!Array.isArray(events)) return json({ error: 'Unexpected claim response' }, 502);
  let accepted = 0, failed = 0;
  for (const event of events) {
    let success = false;
    let error = 'No eligible subscriptions';
    try {
      let payload;
      if (event.event_type === 'delivery_assigned') {
        const routeUrl = new URL(`${base}/rest/v1/delivery_routes`);
        routeUrl.searchParams.set('select', 'id,driver_id,dispatched_at');
        routeUrl.searchParams.set('id', `eq.${event.reference_id}`);
        routeUrl.searchParams.set('limit', '1');
        const routeResponse = await supabaseCall(base, key, routeUrl.pathname + routeUrl.search);
        if (!routeResponse.ok) throw Error(`Route query ${routeResponse.status}`);
        const routes = await routeResponse.json();
        if (!routes.length || !routes[0].dispatched_at || routes[0].driver_id !== event.recipient_user_id) throw Error('Route mismatch');
        payload = { title: 'Inmensa Mar · Nueva entrega', body: 'Tenés una entrega asignada. Tocá para verla.', url: '/' };
      } else if (event.event_type === 'customer_order_created') {
        const orderUrl = new URL(`${base}/rest/v1/customer_orders`);
        orderUrl.searchParams.set('select', 'id,created_at');
        orderUrl.searchParams.set('id', `eq.${event.reference_id}`);
        orderUrl.searchParams.set('limit', '1');
        const orderResponse = await supabaseCall(base, key, orderUrl.pathname + orderUrl.search);
        if (!orderResponse.ok) throw Error(`Order query ${orderResponse.status}`);
        const orders = await orderResponse.json();
        if (!orders.length) throw Error('Order not found');
        const staffUrl = new URL(`${base}/rest/v1/staff_profiles`);
        staffUrl.searchParams.set('select', 'user_id,role,active');
        staffUrl.searchParams.set('user_id', `eq.${event.recipient_user_id}`);
        staffUrl.searchParams.set('limit', '1');
        const staffResponse = await supabaseCall(base, key, staffUrl.pathname + staffUrl.search);
        if (!staffResponse.ok) throw Error(`Staff query ${staffResponse.status}`);
        const staff = await staffResponse.json();
        if (!staff.length || !staff[0].active || !['admin', 'counter'].includes(staff[0].role)) throw Error('Recipient not eligible');
        payload = { title: 'Inmensa Mar · Nuevo pedido', body: 'Hay un pedido nuevo para revisar.', url: '/' };
      } else {
        throw Error('Unsupported event');
      }
      // Check the recipient's current preferences, including events queued before an opt-out.
      const prefUrl = new URL(`${base}/rest/v1/push_preferences`);
      prefUrl.searchParams.set('select', 'new_orders,deliveries');
      prefUrl.searchParams.set('user_id', `eq.${event.recipient_user_id}`);
      prefUrl.searchParams.set('limit', '1');
      const prefResponse = await supabaseCall(base, key, prefUrl.pathname + prefUrl.search);
      if (!prefResponse.ok) throw Error(`Preference query ${prefResponse.status}`);
      const prefs = await prefResponse.json();
      const optedOut = event.event_type === 'customer_order_created'
        ? prefs[0]?.new_orders === false
        : prefs[0]?.deliveries === false;
      if (optedOut) {
        // Mark as consumed so it is not retried. 'sent' here means processed,
        // not that a push was delivered; no push is sent for opted-out events.
        const completed = await supabaseCall(base, key, '/rest/v1/rpc/complete_push_event', {
          method: 'POST', body: JSON.stringify({ p_event_id: event.id, p_claim_token: event.claim_token, p_success: true, p_error: null })
        });
        if (!completed.ok) console.error('Push opt-out completion failed', { status: completed.status });
        continue;
      }
      const subscriptionUrl = new URL(`${base}/rest/v1/push_subscriptions`);
      subscriptionUrl.searchParams.set('select', 'endpoint,p256dh,auth_key');
      subscriptionUrl.searchParams.set('user_id', `eq.${event.recipient_user_id}`);
      subscriptionUrl.searchParams.set('limit', '10');
      const subResponse = await supabaseCall(base, key, subscriptionUrl.pathname + subscriptionUrl.search);
      if (!subResponse.ok) throw Error(`Subscription query ${subResponse.status}`);
      const subs = await subResponse.json();
      let sent = 0;
      for (const sub of subs) {
        if (!permittedEndpoint(sub.endpoint)) continue;
        try {
          const encryptedPayload = await encrypt(sub, payload);
          const authorization = await vapidHeaders(sub.endpoint, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
          const result = await fetch(sub.endpoint, { method: 'POST', headers: {
            authorization, 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '60', urgency: 'normal'
          }, body: encryptedPayload });
          if ([200, 201, 202].includes(result.status)) sent++;
        } catch { /* Other devices can still receive. */ }
      }
      success = sent > 0;
      error = success ? null : 'Push service did not accept notification';
    } catch (e) { error = String(e?.message || 'Push processing failed').slice(0, 120); }
    const completed = await supabaseCall(base, key, '/rest/v1/rpc/complete_push_event', {
      method: 'POST', body: JSON.stringify({ p_event_id: event.id, p_claim_token: event.claim_token, p_success: success, p_error: error })
    });
    if (!completed.ok) console.error('Push completion failed', { status: completed.status });
    if (success) accepted++; else failed++;
  }
  return json({ claimed: events.length, accepted, failed });
}

export function onRequestGet() { return json({ error: 'Method not allowed' }, 405); }
