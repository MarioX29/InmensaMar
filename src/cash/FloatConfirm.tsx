import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
type Row={id:string;cash_day_id:string;driver_id:string;amount_cents:number;declared_at:string};
type Confirm={driver_id:string;cash_day_id:string;amount_cents:number};
const q=(c:number)=>`Q ${(c/100).toFixed(2)}`;
export function FloatConfirm(){
 const [rows,setRows]=useState<Row[]>([]),[confirmed,setConfirmed]=useState<Confirm[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[day,setDay]=useState('');
 const attempts=useRef<Record<string,string>>({});
 const load=useCallback(async()=>{
  if(!supabase)return;
  const d=await supabase.from('cash_days').select('id').eq('status','open').order('business_date',{ascending:false}).limit(1);
  if(d.error){setError(d.error.message);return;}
  const id=d.data?.[0]?.id||'';setDay(id);
  if(!id){setRows([]);setConfirmed([]);return;}
  const [r,c]=await Promise.all([
   supabase.from('driver_cash_floats').select('id,cash_day_id,driver_id,amount_cents,declared_at').eq('cash_day_id',id),
   supabase.from('driver_float_confirmations').select('driver_id,cash_day_id,amount_cents').eq('cash_day_id',id)
  ]);
  if(r.error||c.error){setError(r.error?.message||c.error?.message||'No se pudo consultar sencillo');return;}
  setRows((r.data||[]) as Row[]);setConfirmed((c.data||[]) as Confirm[]);setError('');
 },[]);
 useEffect(()=>{void load();},[load]);
 async function confirm(row:Row){
  if(!supabase||busy||!window.confirm(`¿Confirmás que entregaste ${q(row.amount_cents)} al repartidor?`))return;
  const key=row.cash_day_id+':'+row.driver_id;
  if(!attempts.current[key])attempts.current[key]=crypto.randomUUID();
  setBusy(true);setError('');
  try{
   const {error:e}=await supabase.rpc('confirm_driver_float',{p_request_id:attempts.current[key],p_driver_id:row.driver_id,p_amount_cents:row.amount_cents});
   if(e){setError(e.message+' Verificá antes de repetir.');return;}
   delete attempts.current[key];await load();
  }catch(e){setError(String(e)+' Verificá antes de repetir.');}finally{setBusy(false);}
 }
 return <section className="cash-card"><h3>Confirmar sencillo</h3><p>Confirmá solo dinero realmente entregado por Caja. Las declaraciones no son transferencias confirmadas.</p>
  {!day?<p>No hay jornada abierta.</p>:rows.length===0?<p>Sin declaraciones de sencillo.</p>:<div className="cash-table-wrap"><table><thead><tr><th>Repartidor</th><th>Declarado</th><th>Estado</th></tr></thead><tbody>{rows.map(r=>{
   const done=confirmed.some(c=>c.driver_id===r.driver_id);
   return <tr key={r.id}><td>{r.driver_id.slice(0,8)}</td><td>{q(r.amount_cents)}</td><td>{done?'Confirmado':<button type="button" disabled={busy} onClick={()=>void confirm(r)}>Confirmar entrega</button>}</td></tr>;
  })}</tbody></table></div>}
  <button type="button" disabled={busy} onClick={()=>void load()}>Actualizar sencillo</button>{error&&<p className="cash-error" role="alert">{error}</p>}
  <small>QA: los cierres y retiros con sencillo aún están bloqueados hasta terminar la conciliación por jornada.</small>
 </section>;
}
