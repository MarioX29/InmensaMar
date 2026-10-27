import {configured,json,rpc,limitedJSON,validOrder,clientHash} from '../../server/storefront.js';
const known = {
  INVALID_REQUEST:400, PRICE_CHANGED:409, PRODUCT_UNAVAILABLE:409,
  STOCK_UNAVAILABLE:409, REQUEST_CONFLICT:409, RATE_LIMITED:429
};
export async function onRequest({request,env}) {
  if (request.method !== 'POST') return json({code:'METHOD_NOT_ALLOWED'},405);
  if (!configured(env)) return json({code:'ORDERING_UNAVAILABLE'},503);
  const origin = request.headers.get('origin');
  if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({code:'FORBIDDEN'},403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({code:'INVALID_REQUEST'},415);
  // Cloudflare supplies this header. Do not accept a browser-provided hash or forwarding fallback.
  const ip = request.headers.get('cf-connecting-ip');
  if (!ip) return json({code:'ORDERING_UNAVAILABLE'},503);
  let body;
  try { body = await limitedJSON(request); }
  catch (e) { return json({code:e.message === 'TOO_LARGE'?'TOO_LARGE':'INVALID_REQUEST'}, e.message === 'TOO_LARGE'?413:400); }
  if (!validOrder(body)) return json({code:'INVALID_REQUEST'},400);
  try {
    const result = await rpc(env,'submit_storefront_order',{
      p_request_id: body.request_id, p_customer_name: body.customer_name,
      p_customer_phone: body.customer_phone, p_delivery_address: body.delivery_address,
      p_notes: body.notes, p_items: body.items,
      p_client_hash: await clientHash(ip,env.SUPABASE_SERVICE_ROLE_KEY)
    });
    if (!result.ok) {
      const code = result.data?.message;
      if (Object.hasOwn(known,code)) return json({code},known[code]);
      return json({code:'RESULT_UNCONFIRMED'},503);
    }
    const receipt = result.data;
    if (!receipt || typeof receipt.order_id !== 'string' || !Number.isSafeInteger(Number(receipt.total_cents))) return json({code:'RESULT_UNCONFIRMED'},503);
    // Only receipt fields, never customer details, raw database errors or credentials.
    return json({order_id:receipt.order_id,total_cents:Number(receipt.total_cents)});
  } catch { return json({code:'RESULT_UNCONFIRMED'},503); }
}
