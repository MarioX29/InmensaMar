import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash.css';
type CashDay={id:string;business_date:string;status:'open'|'closed';opening_float_cents:number};
type Withdrawal={id:string;cash_day_id:string;amount_cents:number;note:string|null;created_at:string;recorded_by:string};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const err=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'Error inesperado';
export function CashWithdrawals({onChanged}:{onChanged?:()=>void}){
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
  const r=await supabase.from('cash_withdrawals').select('id,cash_day_id,amount_cents,note,created_at,recorded_by').eq('cash_day_id',latest.id).order('created_at',{ascending:false});
  if(r.error){setError(err(r.error));return;}setRows((r.data||[]) as Withdrawal[]);
 },[]);
 useEffect(()=>{void load();},[load]);
 const cents=/^\d+(?:\.\d{1,2})?$/.test(amount.trim())?Math.round(Number(amount)*100):0;
 const valid=!!day&&day.status==='open'&&cents>0&&note.trim().length<=250&&!busy;
 async function submit(){
  if(!supabase||!day||!valid)return;
  const clean=note.trim();
  if(attempt.current&&(attempt.current.day!==day.id||attempt.current.amount!==cents||attempt.current.note!==clean)){
   setError('Hay un retiro con resultado incierto. No cambies los datos hasta verificarlo.');return;
  }
  if(!attempt.current)attempt.current={id:crypto.randomUUID(),day:day.id,amount:cents,note:clean};
  if(!window.confirm(`¿Confirmar retiro de ${money(cents)}?`))return;
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const r=await supabase.rpc('record_cash_withdrawal',{p_cash_day_id:a.day,p_request_id:a.id,p_amount_cents:a.amount,p_note:a.note||null});
   if(r.error){setError(err(r.error)+' Verificá el historial antes de volver a intentar.');return;}
   attempt.current=null;setAmount('');setNote('');setNotice('Retiro registrado.');await load();onChanged?.();
  }catch(e){setError(err(e)+' Resultado incierto: verificá el historial antes de reintentar.');}
  finally{setBusy(false);}
 }
 return <div className="cash-card"><h3>Registrar retiro</h3>
  <p>Registrá el efectivo que sale de Caja durante la jornada. La nota es opcional.</p>
  {!day?<p>No hay jornada registrada.</p>:day.status!=='open'?<p>La jornada está cerrada. No se permiten retiros.</p>:<>
   <label>Monto (Q)<input inputMode="decimal" value={amount} disabled={busy||!!attempt.current} onChange={e=>setAmount(e.target.value)} placeholder="Ej. 500.00"/></label>
   <label>Nota (opcional)<input maxLength={250} value={note} disabled={busy||!!attempt.current} onChange={e=>setNote(e.target.value)} placeholder="Motivo del retiro"/></label>
   <button className="cash-primary" disabled={!valid} onClick={()=>void submit()}>{busy?'Registrando…':'Confirmar retiro'}</button>
  </>}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  {attempt.current&&<p className="cash-error">Si el resultado fue incierto, verificá el historial antes de registrar otro retiro.</p>}
  <h3>Retiros de la jornada</h3>
  <div className="cash-stats"><article><small>Total retirado</small><strong>{money(rows.reduce((s,r)=>s+Number(r.amount_cents),0))}</strong></article></div>
  {!rows.length?<p>No hay retiros registrados.</p>:<div className="cash-table-wrap"><table><thead><tr><th>Fecha</th><th>Monto</th><th>Nota</th><th>Registrado por</th></tr></thead><tbody>
   {rows.map(r=><tr key={r.id}><td>{new Date(r.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala'})}</td><td>{money(r.amount_cents)}</td><td>{r.note||'—'}</td><td>{r.recorded_by.slice(0,8)}</td></tr>)}
  </tbody></table></div>}
  <button onClick={()=>void load()} disabled={busy}>Actualizar retiros</button>
 </div>;
}
