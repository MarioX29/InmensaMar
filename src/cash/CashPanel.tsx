import {CashWithdrawals} from './CashWithdrawals';
import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash.css';
type Position={user_id:string;display_name:string;collected_cents:number;handed_off_cents:number;remaining_cents:number};
type Overview={cash_cents:number;transfer_reported_cents:number;pending_cents:number;open_issues:number;handed_off_cents:number};
type CashDay={id:string;business_date:string;status:'open'|'closed';opening_float_cents:number;opened_at:string};
type DayBalance={opening_cents:number;counter_sales_cents:number;received_handoffs_cents:number;withdrawals_cents:number;expected_cents:number};
type DailyMovements={cash_cents:number;handoff_cents:number;transfer_cents:number};
type Handoff={id:string;created_at:string;amount_cents:number;from_user_id:string;to_user_id:string;note:string|null};
const money=(v:number)=>`Q ${(Number(v)/100).toFixed(2)}`;
const message=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'Error inesperado';
// Guatemala stays on UTC-06:00 year-round. End is exclusive: midnight starting the next business date.
const guatemalaDayStartUtc=(businessDate:string)=>`${businessDate}T06:00:00.000Z`;
const nextGuatemalaMidnightUtc=(businessDate:string)=>{
 const end=new Date(`${businessDate}T06:00:00.000Z`);
 end.setUTCDate(end.getUTCDate()+1);
 return end.toISOString();
};
export function CashPanel({staffRole}:{staffRole:'admin'|'counter'|'driver'}){
 const [day,setDay]=useState<CashDay|null>(null);
 const [dayError,setDayError]=useState('');
 const [dayBalance,setDayBalance]=useState<DayBalance|null>(null);
 const [balanceError,setBalanceError]=useState('');
 const [overview,setOverview]=useState<Overview|null>(null);
 const [daily,setDaily]=useState<DailyMovements|null>(null);
 const [dailyError,setDailyError]=useState('');
 const [positions,setPositions]=useState<Position[]>([]);
 const [handoffs,setHandoffs]=useState<Handoff[]>([]);
 const [currentUser,setCurrentUser]=useState('');const [source,setSource]=useState('');const [amount,setAmount]=useState('');const [note,setNote]=useState('');
 const [countedAmount,setCountedAmount]=useState('');
 const [closeConfirm,setCloseConfirm]=useState('');
 const [closeBusy,setCloseBusy]=useState(false);
 const [closeError,setCloseError]=useState('');
 const [closeNotice,setCloseNotice]=useState('');
 const closeAttempt=useRef<{requestId:string;dayId:string;counted:number;nextFloat:number}|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const attempt=useRef<{requestId:string;source:string;cents:number;note:string}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase||staffRole!=='admin')return;
  const [o,p,h,d]=await Promise.all([
   supabase.rpc('delivery_cash_overview'),supabase.rpc('delivery_cash_positions'),
   supabase.from('delivery_cash_handoffs').select('id,created_at,amount_cents,from_user_id,to_user_id,note').order('created_at',{ascending:false}).limit(50),
   supabase.from('cash_days').select('id,business_date,status,opening_float_cents,opened_at').order('opened_at',{ascending:false}).limit(1)
  ]);
  if(d.error){setDayError(message(d.error));setDayBalance(null);setBalanceError('');setDaily(null);setDailyError(message(d.error));}
  else{
   const latest=(d.data?.[0] as CashDay|undefined)||null;
   setDay(latest);setDayError('');
   if(latest){
    const start=guatemalaDayStartUtc(latest.business_date);
    const end=nextGuatemalaMidnightUtc(latest.business_date);
    const [paymentsToday,handoffsToday,userToday]=await Promise.all([
     supabase.from('delivery_payment_events').select('amount_cents,method').eq('event_kind','payment').gte('created_at',start).lt('created_at',end),
     supabase.from('delivery_cash_handoffs').select('amount_cents,to_user_id').gte('created_at',start).lt('created_at',end),
     supabase.auth.getUser()
    ]);
    const issue=paymentsToday.error||handoffsToday.error||userToday.error;
    if(issue||!userToday.data.user?.id){setDaily(null);setDailyError(issue?message(issue):'No se pudo identificar al responsable de Caja.');}
    else{
     const uid=userToday.data.user.id;
     const entries=paymentsToday.data||[];
     setDaily({
      cash_cents:entries.filter(e=>e.method==='cash').reduce((n,e)=>n+Number(e.amount_cents),0),
      transfer_cents:entries.filter(e=>e.method==='transfer_reported').reduce((n,e)=>n+Number(e.amount_cents),0),
      handoff_cents:(handoffsToday.data||[]).filter(e=>e.to_user_id===uid).reduce((n,e)=>n+Number(e.amount_cents),0)
     });
     setDailyError('');
    }
   }else{setDaily(null);setDailyError('');}
   if(!latest||latest.status!=='open'){setDayBalance(null);setBalanceError('');}
   else{
    // Count all cash payments within the Guatemala business date, even before opening.
    // A forgotten close must not include payments from the following day.
    const cutoff=nextGuatemalaMidnightUtc(latest.business_date);
    const dayStart=guatemalaDayStartUtc(latest.business_date);
    const [payments,received,userResult,withdrawals]=await Promise.all([
     supabase.from('sale_payments').select('amount_cents,sales!inner(status)').eq('method','cash').eq('status','received').eq('sales.status','completed').gte('created_at',dayStart).lt('created_at',cutoff),
     supabase.from('delivery_cash_handoffs').select('amount_cents,to_user_id').gte('created_at',dayStart).lt('created_at',cutoff),
     supabase.auth.getUser(),
     supabase.from('cash_withdrawals').select('amount_cents').eq('cash_day_id',latest.id)
    ]);
    const calcIssue=payments.error||received.error||userResult.error||withdrawals.error;
    const recipientId=userResult.data.user?.id;
    if(calcIssue||!recipientId){
     setDayBalance(null);setBalanceError(calcIssue?message(calcIssue):'No se pudo identificar al administrador de Caja.');
    }else{
     const counter=(payments.data||[]).reduce((sum,p)=>sum+Number(p.amount_cents),0);
     // QA: count handoffs received by the signed-in admin.
     // Confirm this admin is the configured cash recipient before using for closing.
     const handed=(received.data||[]).filter(h=>h.to_user_id===recipientId).reduce((sum,h)=>sum+Number(h.amount_cents),0);
     const opening=Number(latest.opening_float_cents);
     const taken=(withdrawals.data||[]).reduce((sum,w)=>sum+Number(w.amount_cents),0);
     setDayBalance({opening_cents:opening,counter_sales_cents:counter,received_handoffs_cents:handed,withdrawals_cents:taken,expected_cents:opening+counter+handed-taken});
     setBalanceError('');
    }
   }
  }
  const issue=o.error||p.error||h.error;
  if(issue){setError(message(issue));return;}
  setOverview((o.data||[])[0]||null);setPositions(p.data||[]);setHandoffs(h.data||[]);setError('');
 },[staffRole]);
 useEffect(()=>{void load();void supabase?.auth.getUser().then(({data})=>setCurrentUser(data.user?.id||''));},[load]);
 useEffect(()=>{
  if(staffRole!=='admin')return;
  const refresh=()=>{
   const visible=document.visibilityState==='visible';
   if(visible)void load();
  };
  const interval=window.setInterval(refresh,15000);
  const onVisible=()=>{if(document.visibilityState==='visible')refresh();};
  document.addEventListener('visibilitychange',onVisible);
  window.addEventListener('focus',refresh);
  return ()=>{window.clearInterval(interval);document.removeEventListener('visibilitychange',onVisible);window.removeEventListener('focus',refresh);};
 },[load,staffRole]);
 const parseQuetzales=(value:string)=>/^\d+(?:\.\d{1,2})?$/.test(value.trim())?Math.round(Number(value.trim())*100):null;
 const countedCents=parseQuetzales(countedAmount);
 const nextFloatCents=0; // El dueno retira todo; no queda efectivo reservado en el local.
 const closingDifference=dayBalance!==null&&countedCents!==null?countedCents-dayBalance.expected_cents:null;
 const closingWithdrawal=countedCents;
 const canClose=!!day&&day.status==='open'&&!!dayBalance&&!balanceError&&countedCents!==null&&nextFloatCents!==null&&nextFloatCents<=countedCents&&closeConfirm==='CERRAR'&&!closeBusy&&!busy;
 async function confirmClose(){
  if(!supabase||!canClose||!day||countedCents===null||nextFloatCents===null)return;
  if(closeAttempt.current&&(closeAttempt.current.dayId!==day.id||closeAttempt.current.counted!==countedCents||closeAttempt.current.nextFloat!==nextFloatCents)){
   setCloseError('Hay un cierre con resultado incierto. Revisá la jornada antes de intentar otro.');return;
  }
  if(!closeAttempt.current)closeAttempt.current={requestId:crypto.randomUUID(),dayId:day.id,counted:countedCents,nextFloat:nextFloatCents};
  setCloseBusy(true);setCloseError('');setCloseNotice('');
  try{
   const a=closeAttempt.current;
   const {error:e}=await supabase.rpc('close_cash_day',{p_cash_day_id:a.dayId,p_request_id:a.requestId,p_counted_cents:a.counted,p_next_day_float_cents:a.nextFloat});
   if(e){setCloseError(message(e)+' Revisá el estado de la jornada antes de reintentar.');return;}
   closeAttempt.current=null;setCloseConfirm('');setCloseNotice('Jornada cerrada. Revisá el historial antes de abrir la siguiente.');
   await load();
  }catch(e){setCloseError(message(e)+' Resultado incierto: revisá la jornada antes de reintentar.');}
  finally{setCloseBusy(false);}
 }
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
 if(staffRole==='driver')return <section className="cash-panel">Acceso restringido a Caja.</section>;
 if(staffRole==='counter')return <section className="cash-panel"><div className="cash-head"><h2>Caja</h2></div><CashWithdrawals/></section>;
 return <section className="cash-panel">
  <div className="cash-head"><div><h2>Caja</h2><p>Control de Caja, entregas y retiros de efectivo.</p></div><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
  <div className="cash-card" aria-label="Jornada de Caja">
   <h3>Jornada de Caja</h3>
   {dayError?<p className="cash-error" role="alert">No se pudo consultar la apertura: {dayError}</p>:day?<>
    <p>{day.status==='open'?'Caja abierta':'Caja cerrada'} · {day.business_date}</p>
    <div className="cash-stats"><article><small>Sencillo inicial registrado</small><strong>{money(day.opening_float_cents)}</strong></article></div>
    <small>El sencillo inicial no es una venta.</small>
    {day.status==='open'&&<div className="cash-day-summary">
     <h3>Efectivo esperado en mostrador</h3>
     {balanceError?<p className="cash-error" role="alert">No se pudo calcular: {balanceError}</p>:dayBalance?<>
      <div className="cash-stats"><article><small>Esperado de la jornada</small><strong>{money(dayBalance.expected_cents)}</strong></article></div>
      <div className="cash-day-breakdown">
       <div><span>Sencillo inicial</span><strong>{money(dayBalance.opening_cents)}</strong></div>
       <div><span>Ventas en efectivo de la jornada</span><strong>{money(dayBalance.counter_sales_cents)}</strong></div>
       <div><span>Liquidaciones de la jornada</span><strong>{money(dayBalance.received_handoffs_cents)}</strong></div>
       <div><span>Retiros de la jornada</span><strong>−{money(dayBalance.withdrawals_cents)}</strong></div>
      </div>
      <small>Estimación para QA, limitada a la fecha comercial de Guatemala. Incluye retiros registrados. No contempla gastos, devoluciones ni conciliación de movimientos de sencillo. Solo QA.</small>
     </>:<p>Calculando efectivo esperado…</p>}
    </div>}
   </>:<p>No hay jornadas de Caja registradas.</p>}
  </div>
  <CashWithdrawals onChanged={()=>void load()}/>
  {day?.status==='open'&&<div className="cash-card" aria-label="Simulador de cierre diario">
   <h3>Simular cierre diario</h3>
   <p>Ingresá el efectivo contado. Al cerrar, el dueño retira todo el efectivo; no queda sencillo en el local.</p>
   <label>Efectivo contado (Q)<input inputMode="decimal" value={countedAmount} onChange={e=>setCountedAmount(e.target.value)} placeholder="Ej. 962.50"/></label>
   {dayBalance? <div className="cash-day-breakdown">
    <div><span>Efectivo esperado (estimación QA)</span><strong>{money(dayBalance.expected_cents)}</strong></div>
    <div><span>Diferencia (contado - esperado)</span><strong>{closingDifference===null?'—':`${closingDifference<0?'-':''}${money(Math.abs(closingDifference))}`}</strong></div>
    <div><span>Efectivo que retira el dueño</span><strong>{closingWithdrawal===null?'—':money(closingWithdrawal)}</strong></div>
   </div>:<p>Esperando el cálculo del efectivo esperado.</p>}
   <small>Este cierre todavía está en QA: no contempla gastos, devoluciones ni todos los movimientos. Usar únicamente con jornadas ficticias verificadas.</small>
   <label>Para confirmar una jornada de prueba, escribí CERRAR<input value={closeConfirm} onChange={e=>setCloseConfirm(e.target.value)} placeholder="CERRAR" disabled={closeBusy||busy}/></label>
   <button className="cash-primary" disabled={!canClose} onClick={()=>void confirmClose()}>{closeBusy?'Confirmando…':'Confirmar cierre de prueba'}</button>
   {closeError&&<p className="cash-error" role="alert">{closeError}</p>}
   {closeNotice&&<p className="cash-notice" role="status">{closeNotice}</p>}
  </div>}
  {closeNotice&&<p className="cash-notice" role="status">{closeNotice}</p>}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  <div className="cash-card">
   <h3>Movimientos de la jornada{day?` · ${day.business_date}`:''}</h3>
   <p>Solo operaciones de la fecha comercial de Guatemala. Las liquidaciones trasladan dinero, no son ventas nuevas.</p>
   {dailyError&&<p className="cash-error" role="alert">No se pudieron consultar los movimientos: {dailyError}</p>}
   {!day?<p>No hay jornada registrada.</p>:!daily?<p>Consultando movimientos…</p>:<div className="cash-stats">
    <article><small>Cobros en efectivo de reparto</small><strong>{money(daily.cash_cents)}</strong></article>
    <article><small>Liquidaciones recibidas</small><strong>{money(daily.handoff_cents)}</strong></article>
    <article><small>Transferencias reportadas</small><strong>{money(daily.transfer_cents)}</strong></article>
   </div>}
  </div>
  <div className="cash-card"><h3>Pendientes e incidencias · acumulados</h3>
   <div className="cash-stats">
    <article><small>Clientes con saldo pendiente</small><strong>{money(overview?.pending_cents||0)}</strong></article>
    <article><small>Incidencias abiertas</small><strong>{overview?.open_issues||0}</strong></article>
   </div>
  </div>
  <div className="cash-card"><h3>Pendiente por liquidar · repartidores</h3><p>Saldos históricos todavía bajo responsabilidad de repartidores. No incluye al dueño, que retira el efectivo al cerrar Caja.</p>
   <div className="cash-table-wrap"><table><thead><tr><th>Persona</th><th>Cobrado</th><th>Entregado</th><th>Pendiente</th></tr></thead><tbody>{positions.filter(x=>x.user_id!==currentUser).map(x=><tr key={x.user_id}><td>{x.display_name}</td><td>{money(x.collected_cents)}</td><td>{money(x.handed_off_cents)}</td><td><strong>{money(x.remaining_cents)}</strong></td></tr>)}</tbody></table></div>
   {!positions.some(x=>x.user_id!==currentUser)&&<p>No hay repartidores con movimientos registrados.</p>}
   <small>El saldo histórico del administrador se omite de esta lista; aún no se ha conciliado contablemente contra los retiros de cierres anteriores.</small>
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
  <p className="cash-footnote">QA: los movimientos diarios y los pendientes históricos son conceptos distintos. Los retiros de Caja no ajustan el saldo histórico de repartidores en Supabase. No utilizar como conciliación contable definitiva.</p>
 </section>;
}
