import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash.css';
type Position={user_id:string;display_name:string;collected_cents:number;handed_off_cents:number;remaining_cents:number};
type Overview={cash_cents:number;transfer_reported_cents:number;pending_cents:number;open_issues:number;handed_off_cents:number};
type Handoff={id:string;created_at:string;amount_cents:number;from_user_id:string;to_user_id:string;note:string|null};
const money=(v:number)=>`Q ${(Number(v)/100).toFixed(2)}`;
const message=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'Error inesperado';
export function CashPanel({staffRole}:{staffRole:'admin'|'counter'|'driver'}){
 const [overview,setOverview]=useState<Overview|null>(null);
 const [positions,setPositions]=useState<Position[]>([]);
 const [handoffs,setHandoffs]=useState<Handoff[]>([]);
 const [currentUser,setCurrentUser]=useState('');const [source,setSource]=useState('');const [amount,setAmount]=useState('');const [note,setNote]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const attempt=useRef<{requestId:string;source:string;cents:number;note:string}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase||staffRole!=='admin')return;
  const [o,p,h]=await Promise.all([
   supabase.rpc('delivery_cash_overview'),supabase.rpc('delivery_cash_positions'),
   supabase.from('delivery_cash_handoffs').select('id,created_at,amount_cents,from_user_id,to_user_id,note').order('created_at',{ascending:false}).limit(50)
  ]);
  const issue=o.error||p.error||h.error;
  if(issue){setError(message(issue));return;}
  setOverview((o.data||[])[0]||null);setPositions(p.data||[]);setHandoffs(h.data||[]);setError('');
 },[staffRole]);
 useEffect(()=>{void load();void supabase?.auth.getUser().then(({data})=>setCurrentUser(data.user?.id||''));},[load]);
 const selected=positions.find(x=>x.user_id===source);
 const cents=amount.trim()&&/^\d+(\.\d{1,2})?$/.test(amount)?Math.round(Number(amount)*100):0;
 const canSubmit=!!selected&&cents>0&&cents<=Number(selected.remaining_cents)&&!busy;
 async function submit(){
  if(!supabase||!canSubmit)return;
  const n=note.trim();
  if(attempt.current&&(attempt.current.source!==source||attempt.current.cents!==cents||attempt.current.note!==n)){
   setError('Existe una entrega anterior con resultado incierto. Verificá antes de registrar otra.');return;
  }
  if(!attempt.current)attempt.current={requestId:crypto.randomUUID(),source,cents,note:n};
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const {error:e}=await supabase.rpc('record_delivery_cash_handoff',{
    p_request_id:a.requestId,p_from_user_id:a.source,p_amount_cents:a.cents,p_note:a.note||null
   });
   if(e){setError(message(e)+' Verificá el historial antes de reintentar.');return;}
   attempt.current=null;setAmount('');setNote('');setNotice('Entrega de efectivo registrada.');await load();
  }catch(e){setError(message(e)+' Verificá el historial antes de reintentar.');}
  finally{setBusy(false);}
 }
 if(staffRole!=='admin')return <section className="cash-panel">Acceso restringido a administradores.</section>;
 return <section className="cash-panel">
  <div className="cash-head"><div><h2>Caja</h2><p>Control de efectivo de entregas. No incluye ventas de mostrador ni gastos.</p></div><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  <div className="cash-stats">
   <article><small>Efectivo cobrado en reparto</small><strong>{money(overview?.cash_cents||0)}</strong></article>
   <article><small>Efectivo entregado al responsable de Caja</small><strong>{money(overview?.handed_off_cents||0)}</strong></article>
   <article><small>Transferencias reportadas</small><strong>{money(overview?.transfer_reported_cents||0)}</strong></article>
   <article><small>Clientes con saldo pendiente</small><strong>{money(overview?.pending_cents||0)}</strong></article>
   <article><small>Incidencias abiertas</small><strong>{overview?.open_issues||0}</strong></article>
  </div>
  <div className="cash-card"><h3>Efectivo por persona</h3><p>El saldo indica efectivo registrado bajo su responsabilidad, no un conteo físico.</p>
   <div className="cash-table-wrap"><table><thead><tr><th>Persona</th><th>Cobrado</th><th>Entregado</th><th>Por entregar</th></tr></thead><tbody>{positions.map(x=><tr key={x.user_id}><td>{x.display_name}</td><td>{money(x.collected_cents)}</td><td>{money(x.handed_off_cents)}</td><td><strong>{money(x.remaining_cents)}</strong></td></tr>)}</tbody></table></div>
   {!positions.length&&<p>No hay cobros en efectivo registrados.</p>}
  </div>
  <div className="cash-card"><h3>Registrar entrega de efectivo</h3><p>El administrador registra el efectivo entregado al responsable de Caja configurado en Supabase. Confirmá que el dinero fue recibido físicamente.</p>
   <label>Persona que entrega<select value={source} disabled={busy||!!attempt.current} onChange={e=>setSource(e.target.value)}><option value="">Seleccionar persona</option>{positions.filter(x=>x.user_id!==currentUser&&Number(x.remaining_cents)>0).map(x=><option key={x.user_id} value={x.user_id}>{x.display_name} · {money(x.remaining_cents)}</option>)}</select></label>
   <label>Monto recibido (Q)<input inputMode="decimal" value={amount} disabled={busy||!!attempt.current} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>
   <label>Nota (opcional)<input maxLength={250} value={note} disabled={busy||!!attempt.current} onChange={e=>setNote(e.target.value)} placeholder="Ej. efectivo de la tarde"/></label>
   <button className="cash-primary" disabled={!canSubmit} onClick={()=>void submit()}>{busy?'Registrando…':'Confirmar efectivo recibido'}</button>
   {attempt.current&&<p className="cash-error">Solicitud incierta: comprobá el historial antes de otra operación.</p>}
   <small>Este registro no altera ventas ni cobros originales.</small>
  </div>
  <div className="cash-card"><h3>Últimas entregas de efectivo</h3>{!handoffs.length?<p>Todavía no hay entregas registradas.</p>:<div className="cash-table-wrap"><table><thead><tr><th>Fecha</th><th>De</th><th>Importe</th><th>Nota</th></tr></thead><tbody>{handoffs.map(h=><tr key={h.id}><td>{new Date(h.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala'})}</td><td>{positions.find(p=>p.user_id===h.from_user_id)?.display_name||h.from_user_id.slice(0,8)}</td><td>{money(h.amount_cents)}</td><td>{h.note||'—'}</td></tr>)}</tbody></table></div>}</div>
  <p className="cash-footnote">Piloto: solo efectivo de reparto. Transferencias reportadas no equivalen a verificación bancaria. No incluye gastos, retiros, devoluciones ni conciliación de mostrador.</p>
 </section>;
}
