import {configured,json,rpc} from '../../server/storefront.js';
export async function onRequest({request,env}) {
  if (request.method !== 'GET') return json({code:'METHOD_NOT_ALLOWED'},405);
  if (!configured(env)) return json({code:'ORDERING_UNAVAILABLE'},503);
  try {
    const result = await rpc(env,'storefront_catalog',{});
    if (!result.ok || !Array.isArray(result.data?.products)) return json({code:'ORDERING_UNAVAILABLE'},503);
    return json(result.data);
  } catch { return json({code:'ORDERING_UNAVAILABLE'},503); }
}
