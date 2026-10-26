import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash.css';
type CashDay={id:string;business_date:string;status:'open'|'closed';opening_float_cents:number};
type Withdrawal={id:string;cash_day_id:string;amount_cents:number;note:string|null;created_at:string;recorded_by:string;source_errand_id:string|null};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const err=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'Error inesperado';
export function CashWithdrawals({onChanged,cashDay,mode,onCancel}:{onChanged?:()=>void;cashDay?:{id:string;status:string}|null;mode?:'form'|'history';onCancel?:()=>void}){
 const [localFormOpen,setLocalFormOpen]=useState(false);
 const formOpen=mode==='form'||localFormOpen;
 const [day,setDay]=useState<CashDay|null>(null);
 const [rows,setRows]=useState<Withdrawal[]>([]);
 const [amount,setAmount]=useState('');const [note,setNote]=useState('');
 const [error,setError]=useState('');const [notice,setNotice]=useState('');const [busy,setBusy]=useState(false);
 const attempt=useRef<{id:string;day:string;amount:number;note:string}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase)return;
  const d=await supabase.from('cash_days').select('id,business_date,status,opening_float_cents').order('business_date',{ascending:false}).limit(1);
  if(d.error){setError(err(d.error));return;}
  const latest=(d.data?.[0] as CashDay|undefined)||null;setDay(latest);
  if(!latest){setRows([]);return;}
  const r=await supabase.from('cash_withdrawals').select('id,cash_day_id,amount_cents,note,created_at,recorded_by,source_errand_id').eq('cash_day_id',latest.id).order('created_at',{ascending:false});
  if(r.error){if(r.error.code==='P0001')attempt.current=null;setError(err(r.error));return;}setRows((r.data||[]) as Withdrawal[]);
 },[]);
 useEffect(()=>{void load();},[load,cashDay?.id,cashDay?.status]);
 useEffect(()=>{const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load();},15000);return()=>window.clearInterval(timer);},[load]);
 const cents=/^\d+(?:\.\d{1,2})?$/.test(amount.trim())?Math.round(Number(amount)*100):0;
 const valid=!!day&&day.status==='open'&&Number.isSafeInteger(cents)&&cents>0&&note.trim().length<=250&&!busy;
 async function submit(){
  if(!supabase||!day||!valid)return;
  const clean=note.trim();
  if(attempt.current&&(attempt.current.day!==day.id||attempt.current.amount!==cents||attempt.current.note!==clean)){
   setError('Hay un retiro con resultado incierto. No cambies los datos hasta verificarlo.');return;
  }
  if(!attempt.current&&!window.confirm(`¿Confirmar retiro de ${money(cents)}?`))return;
  if(!attempt.current)attempt.current={id:crypto.randomUUID(),day:day.id,amount:cents,note:clean};
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const r=await supabase.rpc('record_cash_withdrawal',{p_cash_day_id:a.day,p_request_id:a.id,p_amount_cents:a.amount,p_note:a.note||null});
   if(r.error){if(r.error.code==='P0001')attempt.current=null;setError(err(r.error)+' Verificá el historial antes de volver a intentar.');return;}
   attempt.current=null;setAmount('');setNote('');setNotice('Retiro registrado.');await load();onChanged?.();
  }catch(e){setError(err(e)+' Resultado incierto: verificá el historial antes de reintentar.');}
  finally{setBusy(false);}
 }
 return <section className={`cash-card cash-withdrawals${formOpen?' cash-action-panel':''}`} aria-label="Retiros de Caja">
  <div className="cash-section-head"><div><p className="cash-eyebrow">{formOpen?'SALIDA DE EFECTIVO':'ESTA JORNADA'}</p><h2>{formOpen?'Retirar efectivo':'Retiros'}</h2></div>
   {formOpen?<button className="cash-text-button" onClick={()=>{setLocalFormOpen(false);onCancel?.();}}>Volver</button>:mode===undefined&&day?.status==='open'?<button className="cash-secondary" onClick={()=>setLocalFormOpen(true)}>Retirar efectivo</button>:null}
  </div>
  {formOpen&&<>
   <p>Registrá lo que sale directamente de Caja. Las compras personales del repartidor ya se registran al liquidar.</p>
   {!day?<p>No hay jornada registrada.</p>:day.status!=='open'?<p>La jornada está cerrada. No se permiten retiros.</p>:<>
    <label htmlFor="cash-withdraw-amount">Monto (Q)<input id="cash-withdraw-amount" className="cash-amount-input" inputMode="decimal" value={amount} disabled={busy||!!attempt.current} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>
    <label htmlFor="cash-withdraw-note">Nota (opcional)<input id="cash-withdraw-note" maxLength={250} value={note} disabled={busy||!!attempt.current} onChange={e=>setNote(e.target.value)} placeholder="¿Para qué es el retiro?"/></label>
    <button className="cash-primary" disabled={!valid} onClick={()=>void submit()}>{busy?'Registrando…':attempt.current?'Reintentar el mismo retiro':'Confirmar retiro'}</button>
   </>}
  </>}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  {attempt.current&&<p className="cash-error">Resultado incierto. Verificá el registro o reintentá con los mismos datos; no generés otro retiro.</p>}
  {!formOpen&&<>
   <div className="cash-line"><span>Retiros directos</span><strong>{money(rows.filter(r=>!r.source_errand_id).reduce((s,r)=>s+Number(r.amount_cents),0))}</strong></div>
   <div className="cash-line"><span>Compras personales de reparto</span><strong>{money(rows.filter(r=>!!r.source_errand_id).reduce((s,r)=>s+Number(r.amount_cents),0))}</strong></div>
   {!rows.length?<p className="cash-empty">No hay retiros en esta jornada.</p>:<div className="cash-ledger">{rows.map(r=><details className="cash-ledger-entry" key={r.id}>
    <summary><span><strong>{r.note||'Retiro de efectivo'}</strong><small>{new Date(r.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})} · {r.source_errand_id?'Compra personal':'Retiro directo'}</small></span><strong>{money(r.amount_cents)}</strong></summary>
    <p>{r.source_errand_id?'Ya descontada del efectivo recibido en la liquidación.':'Salida directa de Caja.'}</p><small>Registrado por: {r.recorded_by.slice(0,8)}</small>
   </details>)}</div>}
   <button className="cash-text-button" onClick={()=>void load()} disabled={busy}>Actualizar retiros</button>
  </>}
 </section>;
}
