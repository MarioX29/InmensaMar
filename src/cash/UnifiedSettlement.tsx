import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';

type Preview={cash_day_id:string;driver_id:string;driver_name:string;float_cents:number;collected_cents:number;purchases_cents:number;expected_cents:number;settled:boolean};
const money=(n:number)=>`Q ${(Number(n)/100).toFixed(2)}`;
const parse=(v:string)=>/^\d+(?:\.\d{1,2})?$/.test(v.trim())?Math.round(Number(v.trim())*100):null;
export function UnifiedSettlement({onChanged}:{onChanged?:()=>void}){
 const [rows,setRows]=useState<Preview[]>([]),[amounts,setAmounts]=useState<Record<string,string>>({});
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const attempt=useRef<{id:string;day:string;driver:string;counted:number}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase)return;
  const {data,error:e}=await supabase.rpc('driver_day_settlement_preview');
  if(e){setError(e.message);return;}
  setRows((data||[]) as Preview[]);setError('');
 },[]);
 useEffect(()=>{void load();},[load]);
 async function settle(r:Preview){
  if(!supabase||busy)return;
  const counted=parse(amounts[r.driver_id]||'');
  if(counted===null||counted<=0){setError('Ingresá el efectivo contado (mayor a Q0).');return;}
  if(attempt.current&&(attempt.current.driver!==r.driver_id||attempt.current.day!==r.cash_day_id||attempt.current.counted!==counted)){
   setError('Hay una liquidación sin verificar. No cambiés el monto ni el repartidor.');return;
  }
  if(!window.confirm(`¿Recibiste físicamente ${money(counted)} de ${r.driver_name}? Diferencia: ${money(counted-Number(r.expected_cents))}. Esta acción confirma también sus compras.`))return;
  if(!attempt.current)attempt.current={id:crypto.randomUUID(),day:r.cash_day_id,driver:r.driver_id,counted};
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const {error:e}=await supabase.rpc('settle_driver_day',{p_request_id:a.id,p_cash_day_id:a.day,p_driver_id:a.driver,p_counted_cents:a.counted});
   if(e){setError(e.message+' Revisá el registro antes de reintentar.');return;}
   attempt.current=null;setNotice('Liquidación registrada y compras revisadas.');await load();onChanged?.();
  }catch(e){setError(String(e)+' Resultado incierto. Conservá el intento y verificá antes de repetir.');}
  finally{setBusy(false);}
 }
 return <section className="cash-card" aria-label="Liquidación única de repartidores">
  <h3>Liquidación de repartidores</h3>
  <p>Una sola revisión: sencillo declarado, cobros y compras. Confirmá únicamente el efectivo recibido físicamente. Las compras pendientes se aprueban al liquidar; las rechazadas no se descuentan.</p>
  <button type="button" disabled={busy} onClick={()=>void load()}>Actualizar liquidaciones</button>
  {rows.length===0?<p>Sin movimientos de repartidores para la jornada abierta.</p>:rows.map(r=><div className="cash-day-summary" key={r.driver_id}>
   <strong>{r.driver_name} {r.settled?'· Liquidado':''}</strong>
   <div className="cash-day-breakdown">
    <div><span>Sencillo declarado</span><strong>{money(r.float_cents)}</strong></div>
    <div><span>Cobros en efectivo</span><strong>{money(r.collected_cents)}</strong></div>
    <div><span>Compras pendientes o aprobadas</span><strong>−{money(r.purchases_cents)}</strong></div>
    <div><span>Esperado</span><strong>{money(r.expected_cents)}</strong></div>
   </div>
   {!r.settled&&<><label>Efectivo contado (Q)
    <input inputMode="decimal" value={amounts[r.driver_id]||''} disabled={busy||!!attempt.current} placeholder="0.00" onChange={e=>setAmounts(v=>({...v,[r.driver_id]:e.target.value}))}/>
   </label>
   <button className="cash-primary" type="button" disabled={busy||!!attempt.current} onClick={()=>void settle(r)}>Confirmar liquidación</button></>}
  </div>)}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  {attempt.current&&<p className="cash-error">Solicitud incierta. No generés otra liquidación hasta verificarla en Supabase.</p>}
  <small>QA: no cierres Caja todavía. Los cálculos del cierre y la integración final con Finanzas requieren actualización adicional.</small>
 </section>;
}
