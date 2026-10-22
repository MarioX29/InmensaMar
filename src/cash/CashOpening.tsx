import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash-opening.css';

type Day={id:string;business_date:string;status:string;opening_float_cents:number};
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar la apertura.';
const guatemalaDate=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());

export function CashOpening({staffRole}:{staffRole:'admin'|'counter'|'driver'}){
 const [day,setDay]=useState<Day|null>(null);
 const [checking,setChecking]=useState(true);
 const [postponed,setPostponed]=useState(false);
 const [amount,setAmount]=useState('');
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');
 const request=useRef<{id:string;cents:number}|null>(null);
 const check=useCallback(async()=>{
  if(!supabase||staffRole==='driver')return;
  const result=await supabase.from('cash_days').select('id,business_date,status,opening_float_cents').eq('status','open').limit(1);
  if(result.error){setError(errorText(result.error));}else if(result.data?.[0]){setDay(result.data[0]);setError('');}else{const today=await supabase.from('cash_days').select('id,business_date,status,opening_float_cents').eq('business_date',guatemalaDate()).limit(1);if(today.error)setError(errorText(today.error));else{setDay(today.data?.[0]||null);setError('');}}
  setChecking(false);
 },[staffRole]);
 useEffect(()=>{void check();},[check]);
 useEffect(()=>{
  if(staffRole==='driver')return;
  const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void check();},30000);
  return ()=>window.clearInterval(timer);
 },[check,staffRole]);
 if(staffRole==='driver'||!supabase)return null;
 const valid=/^\d+(\.\d{1,2})?$/.test(amount.trim())&&Number.isSafeInteger(Math.round(Number(amount)*100))&&Number(amount)>=0;
 const cents=valid?Math.round(Number(amount)*100):0;
 async function open(){
  if(!supabase||!valid||busy)return;
  if(request.current&&request.current.cents!==cents){setError('Hay un intento anterior sin confirmar. Verificá la jornada antes de cambiar el monto.');return;}
  if(!request.current)request.current={id:crypto.randomUUID(),cents};
  setBusy(true);setError('');
  try{
   const result=await supabase.rpc('open_cash_day',{p_request_id:request.current.id,p_opening_float_cents:cents});
   if(result.error){setError(errorText(result.error)+' Si la apertura pudo registrarse, verificá antes de reintentar.');await check();return;}
   request.current=null;setPostponed(false);await check();
  }catch(e){setError(errorText(e)+' Verificá la jornada antes de reintentar.');}
  finally{setBusy(false);}
 }
 if(checking)return <div className="opening-status">Comprobando apertura de Caja…</div>;
 if(day&&day.status==='closed')return <div className="opening-status">La Caja de hoy ya fue cerrada.</div>;
 if(day)return day.business_date===guatemalaDate()?null:<div className="opening-status opening-warning">Hay una jornada anterior abierta ({day.business_date}). Revisá el cierre antes de abrir una nueva.</div>;
 return <>
  <div className="opening-status opening-warning"><span>Caja todavía no está abierta. Podés seguir vendiendo, pero registrá el sencillo inicial para iniciar el control diario.</span><button type="button" onClick={()=>setPostponed(false)}>Abrir Caja</button></div>
  {!postponed&&<div className="opening-overlay"><section className="opening-dialog" role="dialog" aria-modal="true" aria-labelledby="opening-title">
   <p className="opening-eyebrow">INMENSA MAR · CAJA DIARIA</p>
   <h2 id="opening-title">Abrir Caja</h2>
   <p>¿Con cuánto efectivo comenzamos hoy? Ingresá solamente el monto total del sencillo.</p>
   <label htmlFor="opening-amount">Sencillo inicial (Q)</label>
   <input id="opening-amount" type="text" inputMode="decimal" placeholder="Ej. 200.00" value={amount} disabled={busy||!!request.current} onChange={e=>setAmount(e.target.value)}/>
   <small>El sencillo inicial no cuenta como venta. Podés abrir con Q0.</small>
   {error&&<p className="opening-error" role="alert">{error}</p>}
   <button className="opening-primary" type="button" disabled={!valid||busy} onClick={()=>void open()}>{busy?'Abriendo…':'Abrir Caja'}</button>
   <button className="opening-later" type="button" disabled={busy} onClick={()=>setPostponed(true)}>Abrir después</button>
  </section></div>}
 </>;
}
