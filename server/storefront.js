// Only Pages Functions use the service key. No browser imports this module.
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin'
  }});
}
export function configured(env) {
  return env.PUBLIC_ORDERING_ENABLED === 'true' &&
    typeof env.SUPABASE_URL === 'string' && /^https:\/\//.test(env.SUPABASE_URL) &&
    typeof env.SUPABASE_SERVICE_ROLE_KEY === 'string' && env.SUPABASE_SERVICE_ROLE_KEY.length > 20;
}
export async function rpc(env, name, args) {
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), 12000);
  try {
    const response = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + name, {
      method: 'POST', signal: timer.signal,
      headers: {'content-type':'application/json', apikey:env.SUPABASE_SERVICE_ROLE_KEY,
        authorization:'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY}, body: JSON.stringify(args)
    });
    const data = await response.json();
    return {ok: response.ok, data};
  } finally { clearTimeout(timeout); }
}
export async function limitedJSON(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('INVALID_REQUEST');
  const parts = []; let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16384) { await reader.cancel(); throw new Error('TOO_LARGE'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const p of parts) { bytes.set(p,offset); offset += p.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
}
export async function clientHash(ip, secret) {
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('storefront-rate-v1:' + ip));
  return [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validOrder(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || !uuid.test(x.request_id || '')) return false;
  if (typeof x.customer_name !== 'string' || x.customer_name.trim().length < 2 || x.customer_name.trim().length > 120 ||
      typeof x.customer_phone !== 'string' || !/^\+?[0-9 ()-]{8,22}$/.test(x.customer_phone.trim()) ||
      x.customer_phone.replace(/[^0-9]/g,'').length < 8 || x.customer_phone.replace(/[^0-9]/g,'').length > 15 ||
      typeof x.delivery_address !== 'string' || x.delivery_address.trim().length < 5 || x.delivery_address.trim().length > 300 ||
      typeof x.notes !== 'string' || x.notes.length > 500) return false;
  if (!Array.isArray(x.items) || x.items.length < 1 || x.items.length > 30) return false;
  const ids = new Set();
  for (const item of x.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !uuid.test(item.variant_id || '') ||
        typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1000 ||
        Math.abs(item.quantity * 10000 - Math.round(item.quantity * 10000)) > 1e-7 ||
        !Number.isSafeInteger(item.expected_unit_price_cents) || item.expected_unit_price_cents < 0 ||
        item.expected_unit_price_cents > 2147483647 || ids.has(item.variant_id.toLowerCase())) return false;
    ids.add(item.variant_id.toLowerCase());
  }
  return true;
}
