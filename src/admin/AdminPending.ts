import {supabase} from '../lib/supabase';
export type AdminKind='purchase'|'price'|'catalog'|'adjustment'|'expense'|'minimum';
export type AdminAttempt={id:string;userId:string;kind:AdminKind;payload:Record<string,unknown>;label:string;createdAt:string};
const key=(id:string)=>`im-admin-pending-v1:${id}`;

// getSession reads the cached identity without requiring a network request.
// Server-side RLS and RPC authorization still validate the token on every request.
export async function currentAdminUser(){
 if(!supabase)throw new Error('Supabase no disponible');
 const {data,error}=await supabase.auth.getSession();
 if(error||!data.session?.user?.id)throw new Error('No hay una sesión local disponible. Iniciá sesión cuando recuperés la conexión.');
 return data.session.user.id;
}
export async function getAdminAttempt(){
 const id=await currentAdminUser();
 try{
  const raw=localStorage.getItem(key(id));if(!raw)return null;
  const value=JSON.parse(raw) as AdminAttempt;
  if(value.userId!==id||typeof value.id!=='string'||!value.id)throw new Error('Intento inválido');
  return value;
 }catch{throw new Error('No se pudo leer la operación pendiente; no registrés otra operación hasta revisar el dispositivo.');}
}
export async function saveAdminAttempt(kind:AdminKind,payload:Record<string,unknown>,label:string){
 const userId=await currentAdminUser();
 const old=await getAdminAttempt();
 if(old)throw new Error('Hay una operación administrativa pendiente. Verificala antes de continuar.');
 const attempt:AdminAttempt={id:String(payload.p_request_id),userId,kind,payload,label,createdAt:new Date().toISOString()};
 if(!attempt.id||attempt.id==='undefined')throw new Error('Identificador de solicitud inválido');
 try{localStorage.setItem(key(userId),JSON.stringify(attempt));}catch{throw new Error('No se pudo guardar el intento en este dispositivo. No se envió la operación.');}
 window.dispatchEvent(new Event('im-admin-pending-change'));
 return attempt;
}
export async function clearAdminAttempt(attempt:AdminAttempt){
 const userId=await currentAdminUser();
 if(userId!==attempt.userId)throw new Error('La operación pertenece a otra cuenta');
 const old=await getAdminAttempt();
 if(old?.id!==attempt.id)throw new Error('La operación pendiente cambió');
 localStorage.removeItem(key(userId));
 window.dispatchEvent(new Event('im-admin-pending-change'));
}
export async function verifyAdminAttempt(attempt:AdminAttempt):Promise<'found'|'missing'>{
 if(!supabase)throw new Error('Sin conexión');
 if(typeof navigator!=='undefined'&&!navigator.onLine)throw new Error('Sin internet. Reconectá antes de verificar.');
 const userId=await currentAdminUser();
 if(userId!==attempt.userId)throw new Error('Cuenta distinta');
 // Verify the identity online; a cached session alone is insufficient for reconciliation.
 const {data:authData,error:authError}=await supabase.auth.getUser();
 if(authError)throw new Error('No se pudo validar la sesión o la conexión. Conservamos el intento pendiente.');
 if(authData.user?.id!==userId)throw new Error('La sesión cambió. Conservamos el intento pendiente.');
 const table=attempt.kind==='purchase'?'admin_purchase_events':attempt.kind==='price'?'admin_price_events':attempt.kind==='catalog'?'admin_catalog_events':attempt.kind==='expense'?'operating_expenses':attempt.kind==='minimum'?'admin_stock_minimum_events':'admin_inventory_adjustments';
 const {data,error}=await supabase.from(table).select('id,actor_id').eq('request_id',attempt.id).limit(1);
 if(error)throw new Error('No se pudo verificar el movimiento en Supabase. No repitás la operación. '+error.message);
 if(data?.length){if(data[0].actor_id!==userId)throw new Error('Operación registrada por otra cuenta');return 'found';}
 return 'missing';
}
