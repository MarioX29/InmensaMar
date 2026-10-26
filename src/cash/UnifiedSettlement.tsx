import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';

type Preview={cash_day_id:string;driver_id:string;driver_name:string;float_cents:number;collected_cents:number;purchases_cents:number;expected_cents:number;settled:boolean};
type Purchase={id:string;driver_id:string;description:string;amount_cents:number;category:'personal'|'business';status:string};
const money=(n:number)=>`Q ${(Number(n)/100).toFixed(2)}`;
const parse=(v:string)=>{const cents=Math.round(Number(v.trim())*100);return /^\d+(?:\.\d{1,2})?$/.test(v.trim())&&Number.isSafeInteger(cents)?cents:null;};
export function UnifiedSettlement({onChanged}:{onChanged?:()=>void}){
 const [rows,setRows]=useState<Preview[]>([]),[amounts,setAmounts]=useState<Record<string,string>>({});
 const [purchases,setPurchases]=useState<Purchase[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const attempt=useRef<{id:string;day:string;driver:string;counted:number;preview:Preview}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase)return;
  const {data,error:e}=await supabase.rpc('driver_day_settlement_preview');
  if(e){setRows([]);setError(e.message);return;}
  const previews=(data||[]) as Preview[];
  if(previews.length){
   const result=await supabase.from('driver_cash_errands').select('id,driver_id,description,amount_cents,category,status').eq('cash_day_id',previews[0].cash_day_id).order('created_at');
   if(result.error){setRows([]);setPurchases([]);setError(result.error.message);return;}
   setPurchases((result.data||[]) as Purchase[]);
  }else setPurchases([]);
  setRows(previews);setError('');
 },[]);
 useEffect(()=>{void load();},[load]);
 async function settle(r:Preview){
  if(!supabase||busy)return;
  const counted=parse(amounts[r.driver_id]||'');
  if(counted===null||counted<0){setError('Ingresá el efectivo contado (Q0 o más).');return;}
  if(attempt.current&&(attempt.current.driver!==r.driver_id||attempt.current.day!==r.cash_day_id||attempt.current.counted!==counted)){
   setError('Hay una liquidación sin verificar. No cambiés el monto ni el repartidor.');return;
  }
  if(!attempt.current&&!window.confirm(`¿Confirmás que Caja entregó ${money(r.float_cents)} de sencillo a ${r.driver_name} y que ahora recibiste ${money(counted)}? Diferencia del repartidor: ${money(counted-Number(r.expected_cents))}. Se revisan sus compras y se registra el sencillo una sola vez.`))return;
  if(!attempt.current)attempt.current={id:crypto.randomUUID(),day:r.cash_day_id,driver:r.driver_id,counted,preview:r};
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const {error:e}=await supabase.rpc('settle_driver_day',{p_request_id:a.id,p_cash_day_id:a.day,p_driver_id:a.driver,p_counted_cents:a.counted,p_reviewed_preview:a.preview});
   if(e){if(e.code==='P0001')attempt.current=null;setError(e.message+' Revisá el registro antes de reintentar.');return;}
   attempt.current=null;setNotice('Liquidación registrada y compras revisadas.');await load();onChanged?.();
  }catch(e){setError(String(e)+' Resultado incierto. Conservá el intento y verificá antes de repetir.');}
  finally{setBusy(false);}
 }
 return <section className="cash-card" aria-label="Liquidación única de repartidores">
  <h3>Liquidación de repartidores</h3>
  <p>Una sola revisión: sencillo declarado, cobros y compras. Confirmá únicamente el efectivo recibido físicamente. Al liquidar confirmás también el sencillo que salió de Caja. Las compras personales quedan como retiros del dueño y las del negocio como gastos; no se descuentan dos veces.</p>
  <button type="button" disabled={busy} onClick={()=>void load()}>Actualizar liquidaciones</button>
  {rows.length===0?<p>Sin movimientos de repartidores para la jornada abierta.</p>:rows.map(r=><div className="cash-day-summary" key={r.driver_id}>
   <strong>{r.driver_name} {r.settled?'· Liquidado':''}</strong>
   <div className="cash-day-breakdown">
    <div><span>Sencillo declarado</span><strong>{money(r.float_cents)}</strong></div>
    <div><span>Cobros en efectivo</span><strong>{money(r.collected_cents)}</strong></div>
    <div><span>Compras pendientes o aprobadas</span><strong>−{money(r.purchases_cents)}</strong></div>
    <div><span>Esperado</span><strong>{money(r.expected_cents)}</strong></div>
   </div>
   {purchases.filter(p=>p.driver_id===r.driver_id).map(p=><p key={p.id}>{p.description} · {p.category==='personal'?'Retiro personal':'Gasto del negocio'} · {money(p.amount_cents)}{p.status==='rejected'?' · Rechazada, no descontada':''}</p>)}
   {!r.settled&&<><label>Efectivo contado (Q)
    <input inputMode="decimal" value={amounts[r.driver_id]||''} disabled={busy||!!attempt.current} placeholder="0.00" onChange={e=>setAmounts(v=>({...v,[r.driver_id]:e.target.value}))}/>
   </label>
   <button className="cash-primary" type="button" disabled={busy||(!!attempt.current&&attempt.current.driver!==r.driver_id)} onClick={()=>void settle(r)}>{busy?'Registrando…':attempt.current?.driver===r.driver_id?'Reintentar misma liquidación':'Confirmar liquidación'}</button></>}
  </div>)}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  {attempt.current&&<p className="cash-error">Resultado incierto: comprobá el registro o reintentá la misma liquidación con el mismo monto. El reintento no duplica dinero.</p>}
  <small>Los cobros posteriores a una liquidación se bloquean para esa persona y jornada. Terminá sus entregas antes de liquidar.</small>
 </section>;
}
