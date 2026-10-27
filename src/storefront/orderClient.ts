export type CatalogProduct={id:string;family:string;name:string;unit:'lb'|'unit'|'package';price_cents:number;available:boolean};
export type PublicItem={variant_id:string;quantity:number;expected_unit_price_cents:number};
export type PublicAttempt={request_id:string;customer_name:string;customer_phone:string;delivery_address:string;notes:string;items:PublicItem[]};
export type PublicReceipt={order_id:string;total_cents:number};
export const attemptKey='im-storefront-attempt-v1';
export const receiptKey='im-storefront-receipt-v1';
export const confirmedRejections=new Set(['INVALID_REQUEST','PRICE_CHANGED','PRODUCT_UNAVAILABLE','STOCK_UNAVAILABLE','RATE_LIMITED']);
export const messages:Record<string,string>={
 INVALID_REQUEST:'Revisá los datos y las cantidades del pedido.',
 PRICE_CHANGED:'Cambió un precio. Actualizá el catálogo y revisá el total antes de enviar otra vez.',
 PRODUCT_UNAVAILABLE:'Un producto dejó de estar disponible. Actualizá el catálogo y revisá el pedido.',
 STOCK_UNAVAILABLE:'No hay suficiente producto para esa cantidad. Actualizá el catálogo y ajustá el pedido.',
 RATE_LIMITED:'Hay varios pedidos recientes desde esta conexión. Esperá 15 minutos antes de enviar otro.',
 REQUEST_CONFLICT:'No pudimos verificar la solicitud original. No enviés otra; consultá con el negocio.',
 ORDERING_UNAVAILABLE:'Los pedidos en línea no están disponibles en este momento.',
 RESULT_UNCONFIRMED:'No pudimos confirmar el envío. Usá “Verificar mi envío”; no enviés otro pedido.'
};
export function readAttempt():PublicAttempt|null{
 try{const raw=sessionStorage.getItem(attemptKey);if(!raw)return null;const x=JSON.parse(raw) as PublicAttempt;
  if(typeof x.request_id!=='string'||!Array.isArray(x.items)||typeof x.customer_name!=='string'||typeof x.customer_phone!=='string'||typeof x.delivery_address!=='string'||typeof x.notes!=='string')throw new Error('invalid');
  return x;
 }catch{return null}
}
export function readReceipt():PublicReceipt|null{
 try{const x=JSON.parse(sessionStorage.getItem(receiptKey)||'null') as PublicReceipt|null;return x&&typeof x.order_id==='string'&&Number.isSafeInteger(x.total_cents)?x:null}catch{return null}
}
export async function sendAttempt(attempt:PublicAttempt):Promise<{receipt?:PublicReceipt;code?:string}>{
 const controller=new AbortController();const timeout=window.setTimeout(()=>controller.abort(),18000);
 try{
  const response=await fetch('/api/customer-orders',{method:'POST',headers:{'content-type':'application/json'},
   body:JSON.stringify(attempt),signal:controller.signal,credentials:'omit',cache:'no-store'});
  const result=await response.json() as PublicReceipt&{code?:string};
  if(response.ok&&typeof result.order_id==='string'&&Number.isSafeInteger(result.total_cents)&&result.total_cents>=0)return {receipt:{order_id:result.order_id,total_cents:result.total_cents}};
  return {code:result.code||'RESULT_UNCONFIRMED'};
 }catch{return {code:'RESULT_UNCONFIRMED'}}finally{window.clearTimeout(timeout)}
}

// PostgreSQL rounds positive numeric line totals to the nearest cent.
export function productTotal(quantity:number,price:number):number{
 return Number((BigInt(Math.round(quantity*10000))*BigInt(price)+5000n)/10000n);
}
