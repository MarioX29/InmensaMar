import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';

type Errand={id:string;request_id:string;description:string;amount_cents:number;category:'personal'|'business';status:string;created_at:string};
const msg=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar la operacion.';
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
export function DriverErrands(){
 const [rows,setRows]=useState<Errand[]>([]),[description,setDescription]=useState(''),[amount,setAmount]=useState('');
 const [category,setCategory]=useState<'personal'|'business'>('personal');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const pending=useRef<{id:string;description:string;amount:number;category:'personal'|'business'}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase)return;
  const {data:user,error:userError}=await supabase.auth.getUser();
  if(userError||!user.user){setError('Inicia sesion para consultar encargos.');return;}
  const {data,error:e}=await supabase.from('driver_cash_errands').select('id,request_id,description,amount_cents,category,status,created_at').eq('driver_id',user.user.id).order('created_at',{ascending:false}).limit(30);
  if(e){setError(`No se pudo consultar encargos: ${msg(e)}`);return;}
  setRows((data||[]) as Errand[]);setError('');
 },[]);
 useEffect(()=>{void load();const f=()=>{if(document.visibilityState==='visible')void load();};window.addEventListener('focus',f);return()=>window.removeEventListener('focus',f);},[load]);
 async function submit(){
  if(!supabase||busy)return;
  const desc=description.trim();const a=amount.trim();
  if(desc.length<2||desc.length>250||!/^\d+(?:\.\d{1,2})?$/.test(a)){setError('Ingresá descripción y monto válido (máximo 2 decimales).');return;}
  const cents=Math.round(Number(a)*100);
  if(!Number.isSafeInteger(cents)||cents<=0){setError('El monto debe ser mayor a cero.');return;}
  if(pending.current&&(pending.current.description!==desc||pending.current.amount!==cents||pending.current.category!==category)){setError('Hay un encargo sin verificar. No cambiés los datos hasta resolverlo.');return;}
  if(!pending.current)pending.current={id:crypto.randomUUID(),description:desc,amount:cents,category};
  setBusy(true);setError('');setNotice('');
  try{
   const p=pending.current;
   const {error:e}=await supabase.rpc('report_driver_cash_errand',{p_request_id:p.id,p_description:p.description,p_amount_cents:p.amount,p_category:p.category});
   if(e){setError(`${msg(e)}. Verificá el encargo antes de repetir.`);return;}
   pending.current=null;setDescription('');setAmount('');setNotice('Encargo reportado. Aún necesita aprobación.');await load();
  }catch(e){setError(`${msg(e)}. Resultado incierto; verificá antes de repetir.`);}finally{setBusy(false);}
 }
 async function verify(){
  if(!supabase||!pending.current)return;
  const p=pending.current;setBusy(true);setError('');
  try{
   const {data,error:e}=await supabase.from('driver_cash_errands').select('id').eq('request_id',p.id).limit(1);
   if(e){setError(msg(e));return;}
   if(data?.length){pending.current=null;setDescription('');setAmount('');setNotice('Encargo encontrado en Supabase. No se repitió.');await load();}
   else setError('No aparece registrado. Conservá la solicitud y reintentá la verificación cuando tengas conexión.');
  }catch(e){setError(msg(e));}finally{setBusy(false);}
 }
 return <section className="delivery-card" aria-label="Mis encargos">
  <div className="delivery-card-head"><h2>Compras y encargos</h2><button type="button" disabled={busy} onClick={()=>void load()}>Actualizar</button></div>
  <p className="delivery-subtitle">Registrá compras que hiciste con dinero del negocio. No se descuentan de tu liquidación hasta que las aprueben.</p>
  <label>¿Qué compraste?<input value={description} maxLength={250} onChange={e=>setDescription(e.target.value)} disabled={busy||!!pending.current} placeholder="Ej. huevos y leche"/></label>
  <label>¿Cuánto gastaste? (Q)<input value={amount} inputMode="decimal" onChange={e=>setAmount(e.target.value)} disabled={busy||!!pending.current} placeholder="Ej. 65.00"/></label>
  <label>Tipo de compra<select value={category} onChange={e=>setCategory(e.target.value as 'personal'|'business')} disabled={busy||!!pending.current}><option value="personal">Encargo personal / casa</option><option value="business">Gasto del negocio</option></select></label>
  {pending.current?<button type="button" className="delivery-primary" disabled={busy} onClick={()=>void verify()}>Verificar encargo pendiente</button>:<button type="button" className="delivery-primary" disabled={busy} onClick={()=>void submit()}>{busy?'Registrando…':'Registrar encargo'}</button>}
  {error&&<p role="alert" className="delivery-error">{error}</p>}{notice&&<p role="status" className="delivery-success">{notice}</p>}
  <h3>Encargos recientes</h3>{rows.length===0?<p className="delivery-subtitle">Todavía no hay encargos registrados.</p>:<ul>{rows.map(r=><li key={r.id}>{r.description} · {money(r.amount_cents)} · {r.category==='personal'?'Personal':'Negocio'} · {r.status==='approved'?'Aprobado':r.status==='rejected'?'Rechazado':'Pendiente'}</li>)}</ul>}
 </section>;
}
