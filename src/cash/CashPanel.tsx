import {UnifiedSettlement} from './UnifiedSettlement';
import {CashWithdrawals} from './CashWithdrawals';
import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
import './cash.css';
type Position={user_id:string;display_name:string;collected_cents:number;handed_off_cents:number;remaining_cents:number};
type Overview={cash_cents:number;transfer_reported_cents:number;pending_cents:number;open_issues:number;handed_off_cents:number};
type CashDay={id:string;business_date:string;status:'open'|'closed';opening_float_cents:number;opened_at:string};
type DayBalance={cash_day_id:string;opening_cents:number;counter_sales_cents:number;direct_delivery_cents:number;received_handoffs_cents:number;float_out_cents:number;withdrawals_cents:number;cash_expenses_cents:number;personal_purchases_cents:number;business_purchases_cents:number;driver_difference_cents:number;expected_cents:number;blockers:string[];can_close:boolean;requires_float_confirmation:boolean;unconfirmed_float_cents:number;counted_cents?:number;drawer_difference_cents?:number;owner_withdrawal_cents?:number};
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
 const [tab,setTab]=useState<'today'|'drivers'|'history'>('today');
 const [action,setAction]=useState<'withdraw'|'close'|'handoff'|null>(null);
 const [refreshSignal,setRefreshSignal]=useState(0);
 const [settlementSummary,setSettlementSummary]=useState<{pending:number;settled:number}|null>(null);
 const onSettlementSummary=useCallback((value:{pending:number;settled:number}|null)=>setSettlementSummary(value),[]);
 const [day,setDay]=useState<CashDay|null>(null);
 const [dayError,setDayError]=useState('');
 const [dayBalance,setDayBalance]=useState<DayBalance|null>(null);
 const [balanceError,setBalanceError]=useState('');
 const [overview,setOverview]=useState<Overview|null>(null);
 const [daily,setDaily]=useState<DailyMovements|null>(null);
 const [dailyError,setDailyError]=useState('');
 const [positions,setPositions]=useState<Position[]>([]);
 const [driverIds,setDriverIds]=useState<string[]>([]);
 const [handoffs,setHandoffs]=useState<Handoff[]>([]);
 const [currentUser,setCurrentUser]=useState('');const [source,setSource]=useState('');const [amount,setAmount]=useState('');const [note,setNote]=useState('');
 const [countedAmount,setCountedAmount]=useState('');
 const [closeConfirm,setCloseConfirm]=useState('');
 const [confirmFloatOrigin,setConfirmFloatOrigin]=useState(false);
 const [closeBusy,setCloseBusy]=useState(false);
 const [closeError,setCloseError]=useState('');
 const [closeNotice,setCloseNotice]=useState('');
 const closeAttempt=useRef<{requestId:string;dayId:string;counted:number;nextFloat:number;balance:DayBalance;confirmFloatOrigin:boolean}|null>(null);
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const attempt=useRef<{requestId:string;source:string;cents:number;note:string}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase||staffRole!=='admin')return;
  const [o,p,h,d,drivers]=await Promise.all([
   supabase.rpc('delivery_cash_overview'),supabase.rpc('delivery_cash_positions'),
   supabase.from('delivery_cash_handoffs').select('id,created_at,amount_cents,from_user_id,to_user_id,note').order('created_at',{ascending:false}).limit(50),
   supabase.from('cash_days').select('id,business_date,status,opening_float_cents,opened_at').order('opened_at',{ascending:false}).limit(1),
   supabase.from('staff_profiles').select('user_id').eq('role','driver')
  ]);
  setDriverIds((drivers.data||[]).map(row=>row.user_id));
  if(d.error){setDay(null);setDayError(message(d.error));setDayBalance(null);setBalanceError('');setDaily(null);setDailyError(message(d.error));}
  else{
   const latest=(d.data?.[0] as CashDay|undefined)||null;
   setDay(latest);setDayError('');
   if(latest){
    const start=guatemalaDayStartUtc(latest.business_date);
    const end=nextGuatemalaMidnightUtc(latest.business_date);
    const [paymentsToday,handoffsToday,userToday]=await Promise.all([
     supabase.from('delivery_payment_events').select('amount_cents,method').eq('event_kind','payment').gte('created_at',start).lt('created_at',end),
     supabase.from('delivery_cash_handoffs').select('amount_cents,to_user_id').eq('cash_day_id',latest.id),
     supabase.auth.getUser()
    ]);
    const issue=paymentsToday.error||handoffsToday.error||userToday.error;
    if(issue||!userToday.data.user?.id){setDaily(null);setDailyError(issue?message(issue):'No se pudo identificar al responsable de Caja.');}
    else{
     const entries=paymentsToday.data||[];
     setDaily({
      cash_cents:entries.filter(e=>e.method==='cash').reduce((n,e)=>n+Number(e.amount_cents),0),
      transfer_cents:entries.filter(e=>e.method==='transfer_reported').reduce((n,e)=>n+Number(e.amount_cents),0),
      handoff_cents:(handoffsToday.data||[]).reduce((n,e)=>n+Number(e.amount_cents),0)
     });
     setDailyError('');
    }
   }else{setDaily(null);setDailyError('');}
   if(!latest){setDayBalance(null);setBalanceError('');}
   else{
    const balance=await supabase.rpc('cash_day_reconciliation',{p_cash_day_id:latest.id});
    if(balance.error){setDayBalance(null);setBalanceError(message(balance.error));}
    else if(!balance.data||balance.data.cash_day_id!==latest.id||!Number.isSafeInteger(balance.data.expected_cents)||!Array.isArray(balance.data.blockers)){
     setDayBalance(null);setBalanceError('La conciliación recibida no es válida. Actualizá Caja.');
    }else{setDayBalance(balance.data as DayBalance);setBalanceError('');}
   }
  }
  const issue=o.error||p.error||h.error||drivers.error;
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
 const parseQuetzales=(value:string)=>{const cents=Math.round(Number(value.trim())*100);return /^\d+(?:\.\d{1,2})?$/.test(value.trim())&&Number.isSafeInteger(cents)?cents:null;};
 const countedCents=parseQuetzales(countedAmount);
 const nextFloatCents=0; // El dueno retira todo; no queda efectivo reservado en el local.
 const closingDifference=dayBalance!==null&&countedCents!==null?countedCents-dayBalance.expected_cents:null;
 const closingWithdrawal=countedCents;
 const canClose=!!day&&day.status==='open'&&!!dayBalance&&dayBalance.cash_day_id===day.id&&dayBalance.can_close&&(!dayBalance.requires_float_confirmation||confirmFloatOrigin)&&!balanceError&&!dayError&&countedCents!==null&&closeConfirm.trim()==='CERRAR'&&!closeBusy&&!busy;
 async function confirmClose(){
  if(!supabase||!canClose||!day||!dayBalance||countedCents===null)return;
  if(closeAttempt.current&&(closeAttempt.current.dayId!==day.id||closeAttempt.current.counted!==countedCents||closeAttempt.current.nextFloat!==nextFloatCents)){
   setCloseError('Hay un cierre con resultado incierto. Revisá la jornada antes de intentar otro.');return;
  }
  if(!closeAttempt.current)closeAttempt.current={requestId:crypto.randomUUID(),dayId:day.id,counted:countedCents,nextFloat:nextFloatCents,balance:dayBalance,confirmFloatOrigin};
  setCloseBusy(true);setCloseError('');setCloseNotice('');
  try{
   const a=closeAttempt.current;
   const {error:e}=await supabase.rpc('close_cash_day',{p_cash_day_id:a.dayId,p_request_id:a.requestId,p_counted_cents:a.counted,p_next_day_float_cents:a.nextFloat,p_reviewed_balance:a.balance,p_confirm_float_origin:a.confirmFloatOrigin});
   if(e){if(e.code==='P0001'){closeAttempt.current=null;await load();}setCloseError(message(e)+' Revisá la jornada antes de reintentar.');return;}
   closeAttempt.current=null;setCloseConfirm('');setCloseNotice('Jornada cerrada. Revisá el historial antes de abrir la siguiente.');
   await load();
  }catch(e){setCloseError(message(e)+' Resultado incierto: revisá la jornada antes de reintentar.');}
  finally{setCloseBusy(false);}
 }
 useEffect(()=>{if(!closeAttempt.current)setConfirmFloatOrigin(false);},[day?.id,dayBalance?.unconfirmed_float_cents]);
 const refreshAll=()=>{void load();setRefreshSignal(v=>v+1);};
 const showTab=(next:'today'|'drivers'|'history')=>{setTab(next);setAction(null);};
 const businessDate=day?new Intl.DateTimeFormat('es-GT',{day:'numeric',month:'long',year:'numeric',timeZone:'America/Guatemala'}).format(new Date(`${day.business_date}T12:00:00-06:00`)):'Sin jornada';
 const selected=positions.find(x=>x.user_id===source);
 const cents=amount.trim()&&/^\d+(\.\d{1,2})?$/.test(amount)?Math.round(Number(amount)*100):0;
 const canSubmit=!!selected&&!driverIds.includes(selected.user_id)&&Number.isSafeInteger(cents)&&cents>0&&cents<=Number(selected.remaining_cents)&&!busy;
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
   if(e){if(e.code==='P0001')attempt.current=null;setError(message(e)+' Verificá el historial antes de reintentar.');return;}
   attempt.current=null;setAmount('');setNote('');setNotice('Entrega de efectivo registrada.');await load();
  }catch(e){setError(message(e)+' Verificá el historial antes de reintentar.');}
  finally{setBusy(false);}
 }
 if(staffRole==='driver')return <section className="cash-panel">Acceso restringido a Caja.</section>;
 if(staffRole==='counter')return <section className="cash-panel"><header className="cash-head"><div><p className="cash-eyebrow">EFECTIVO DEL NEGOCIO</p><h1>Caja</h1></div></header><CashWithdrawals/></section>;
 return <section className="cash-panel" aria-label="Caja">
  <header className="cash-head">
   <div><p className="cash-eyebrow">EFECTIVO DEL NEGOCIO</p><h1>Caja</h1><p className="cash-date">{businessDate}</p></div>
   <button className="cash-refresh" onClick={refreshAll} disabled={busy||closeBusy} aria-label="Actualizar Caja">Actualizar</button>
  </header>
  {dayError&&<p className="cash-error" role="alert">No se pudo consultar la jornada: {dayError}</p>}
  {balanceError&&day?.status==='open'&&<p className="cash-error" role="alert">No se pudo calcular el saldo: {balanceError}</p>}
  {closeNotice&&<p className="cash-notice" role="status">{closeNotice}</p>}
  {error&&<p className="cash-error" role="alert">{error}</p>}
  {notice&&<p className="cash-notice" role="status">{notice}</p>}

  <div className="cash-hero">
   <div className="cash-hero-top"><span className="cash-status" data-open={day?.status==='open'}><i/>{day?day.status==='open'?'Jornada abierta':'Jornada cerrada':'Sin abrir'}</span><span>{day?.business_date}</span></div>
   <div className="cash-hero-amount"><span>{day?.status==='closed'?'Efectivo contado al cerrar':'Efectivo esperado en Caja'}</span><strong>{dayBalance?money(day?.status==='closed'?dayBalance.counted_cents??dayBalance.expected_cents:dayBalance.expected_cents):'—'}</strong></div>
   <p>{!day?'Abrí la jornada para comenzar el control de efectivo.':day.status==='closed'?'El conteo y las diferencias quedaron registrados.':dayBalance?.requires_float_confirmation?'Antes de cerrar falta confirmar el origen del sencillo.':'Saldo calculado con los movimientos de esta jornada.'}</p>
   {day?.status==='open'&&<div className="cash-actions">
    <button className="cash-light-button" aria-expanded={action==='withdraw'} aria-controls="cash-withdrawal-panel" onClick={()=>{setAction(action==='withdraw'?null:'withdraw');setTab('today');}}>Retirar efectivo <span aria-hidden="true">↗</span></button>
    <button className="cash-outline-button" aria-expanded={action==='close'} aria-controls="cash-closing-panel" onClick={()=>{setAction(action==='close'?null:'close');setTab('today');}}>Cerrar jornada <span aria-hidden="true">→</span></button>
   </div>}
  </div>

  <nav className="cash-tabs" aria-label="Vistas de Caja">
   <button aria-current={tab==='today'?'page':undefined} onClick={()=>showTab('today')}>Hoy</button>
   <button aria-current={tab==='drivers'?'page':undefined} onClick={()=>showTab('drivers')}>Repartidores{settlementSummary&&settlementSummary.pending>0&&<span className="cash-count">{settlementSummary.pending}</span>}</button>
   <button aria-current={tab==='history'?'page':undefined} onClick={()=>showTab('history')}>Historial</button>
  </nav>

  <div id="cash-withdrawal-panel" hidden={action!=='withdraw'&&tab!=='history'}>
   <CashWithdrawals mode={action==='withdraw'?'form':'history'} cashDay={day} onCancel={()=>setAction(null)} onChanged={()=>void load()}/>
  </div>

  <section id="cash-closing-panel" className="cash-card cash-action-panel" hidden={action!=='close'||day?.status!=='open'} aria-label="Cierre diario">
   <div className="cash-section-head"><div><p className="cash-eyebrow">AL TERMINAR EL DÍA</p><h2>Cerrar jornada</h2></div><button className="cash-text-button" onClick={()=>setAction(null)}>Volver</button></div>
   <p>Contá el dinero que queda en Caja. El dueño retira ese efectivo al cerrar.</p>
   {dayBalance?.blockers.map((b,i)=><p className="cash-error" role="alert" key={i}>{b}</p>)}
   <label htmlFor="cash-counted">Efectivo contado (Q)<input id="cash-counted" className="cash-amount-input" inputMode="decimal" value={countedAmount} disabled={closeBusy||!!closeAttempt.current} onChange={e=>setCountedAmount(e.target.value)} placeholder="0.00"/></label>
   {dayBalance&&<div className="cash-close-totals">
    <div><span>Esperado</span><strong>{money(dayBalance.expected_cents)}</strong></div>
    <div><span>Diferencia de Caja</span><strong data-warning={closingDifference!==null&&closingDifference!==0}>{closingDifference===null?'—':money(closingDifference)}</strong></div>
    <div><span>Retiro final del dueño</span><strong>{closingWithdrawal===null?'—':money(closingWithdrawal)}</strong></div>
   </div>}
   {dayBalance&&dayBalance.driver_difference_cents!==0&&<p className="cash-warning">Diferencia de reparto: {money(dayBalance.driver_difference_cents)}. Total con Caja: {closingDifference===null?'—':money(closingDifference+dayBalance.driver_difference_cents)}.</p>}
   {dayBalance?.requires_float_confirmation&&<div className="cash-origin-note">
    <strong>Revisá el sencillo de la liquidación anterior</strong>
    <p>El cálculo descuenta {money(dayBalance.unconfirmed_float_cents)} entregados desde Caja.</p>
    <label className="cash-check"><input type="checkbox" checked={confirmFloatOrigin} disabled={closeBusy||!!closeAttempt.current} onChange={e=>setConfirmFloatOrigin(e.target.checked)}/><span>Confirmo que ese sencillo salió de Caja y estaba incluido en el efectivo del negocio.</span></label>
    <small>Si era dinero propio del repartidor o de otra fuente, no confirmés este cierre.</small>
   </div>}
   <label htmlFor="cash-close-word">Para confirmar el cierre, escribí CERRAR<input id="cash-close-word" autoComplete="off" value={closeConfirm} onChange={e=>setCloseConfirm(e.target.value)} placeholder="Escribí aquí" disabled={closeBusy||busy}/></label>
   <button className="cash-primary" disabled={!canClose} onClick={()=>void confirmClose()}>{closeBusy?'Confirmando…':closeAttempt.current?'Reintentar el mismo cierre':'Confirmar cierre'}</button>
   {closeError&&<p className="cash-error" role="alert">{closeError}</p>}
   {closeAttempt.current&&<small>Conservamos el mismo intento para evitar duplicados. Verificá el resultado antes de iniciar otro.</small>}
  </section>

  <div hidden={tab!=='today'||action!==null} className="cash-today">
   <div className="cash-quick-stats">
    <div><span>Sencillo inicial</span><strong>{day?money(day.opening_float_cents):'—'}</strong></div>
    <div><span>Recibido de reparto</span><strong>{dayBalance?money(dayBalance.received_handoffs_cents):'—'}</strong></div>
    <div><span>Salidas directas</span><strong>{dayBalance?money(dayBalance.withdrawals_cents+dayBalance.cash_expenses_cents):'—'}</strong></div>
   </div>
   {dayBalance&&dayBalance.blockers.length>0&&<div className="cash-warning"><strong>Hay pendientes antes de cerrar</strong>{dayBalance.blockers.map((b,i)=><p key={i}>{b}</p>)}<button className="cash-text-button" onClick={()=>showTab('drivers')}>Revisar repartidores →</button></div>}
   {dayBalance&&dayBalance.driver_difference_cents!==0&&<p className="cash-warning">Diferencias de reparto: {money(dayBalance.driver_difference_cents)}. Se conservan separadas del conteo de Caja.</p>}
   <div className="cash-overview-grid">
    <section className="cash-card cash-driver-shortcut"><div><p className="cash-eyebrow">REPARTO</p><h2>{settlementSummary?settlementSummary.pending>0?`${settlementSummary.pending} pendiente${settlementSummary.pending===1?'':'s'} de liquidar`:settlementSummary.settled>0?'Liquidaciones al día':'Sin movimientos de repartidores':'Consultando liquidaciones…'}</h2><p>{settlementSummary&&settlementSummary.settled>0?`${settlementSummary.settled} liquidación${settlementSummary.settled===1?'':'es'} registrada${settlementSummary.settled===1?'':'s'}.`:'Revisá sencillo, cobros y compras en un solo lugar.'}</p></div><button className="cash-text-button" onClick={()=>showTab('drivers')}>Ver repartidores <span aria-hidden="true">→</span></button></section>
    <section className="cash-card cash-today-movements"><div className="cash-section-head"><h2>Cobros de reparto</h2><span className="cash-muted">Esta jornada</span></div>{dailyError?<p className="cash-error" role="alert">{dailyError}</p>:<>
     <div className="cash-line"><span>En efectivo</span><strong>{daily?money(daily.cash_cents):'—'}</strong></div>
     <div className="cash-line"><span>Transferencias reportadas</span><strong>{daily?money(daily.transfer_cents):'—'}</strong></div>
     <small>Las transferencias no se suman al efectivo de Caja.</small>
    </>}</section>
   </div>
   <details className="cash-disclosure"><summary><span>Ver detalle del saldo</span><span aria-hidden="true">+</span></summary><div className="cash-disclosure-body">
    {dayBalance?<>
     <div className="cash-line"><span>Sencillo inicial</span><strong>{money(dayBalance.opening_cents)}</strong></div>
     <div className="cash-line"><span>Ventas en efectivo de mostrador</span><strong>+{money(dayBalance.counter_sales_cents)}</strong></div>
     <div className="cash-line"><span>Reparto cobrado directamente en Caja</span><strong>+{money(dayBalance.direct_delivery_cents)}</strong></div>
     <div className="cash-line"><span>Liquidaciones y entregas recibidas</span><strong>+{money(dayBalance.received_handoffs_cents)}</strong></div>
     <div className="cash-line"><span>Sencillo entregado a repartidores</span><strong>−{money(dayBalance.float_out_cents)}</strong></div>
     <div className="cash-line"><span>Retiros directos</span><strong>−{money(dayBalance.withdrawals_cents)}</strong></div>
     <div className="cash-line"><span>Gastos pagados desde Caja</span><strong>−{money(dayBalance.cash_expenses_cents)}</strong></div>
     <div className="cash-line cash-line-total"><span>Efectivo esperado</span><strong>{money(dayBalance.expected_cents)}</strong></div>
     <div className="cash-included"><strong>Ya descontadas en la liquidación</strong><div className="cash-line"><span>Compras personales</span><span>{money(dayBalance.personal_purchases_cents)}</span></div><div className="cash-line"><span>Compras del negocio</span><span>{money(dayBalance.business_purchases_cents)}</span></div><small>Son retiros personales o gastos del negocio. No se descuentan otra vez del cajón.</small></div>
     {day?.status==='closed'&&<div className="cash-included"><div className="cash-line"><span>Efectivo contado</span><strong>{money(dayBalance.counted_cents??0)}</strong></div><div className="cash-line"><span>Diferencia de Caja</span><strong>{money(dayBalance.drawer_difference_cents??0)}</strong></div><div className="cash-line"><span>Retiro final del dueño</span><strong>{money(dayBalance.owner_withdrawal_cents??0)}</strong></div></div>}
    </>:<p>{balanceError||'Sin desglose disponible.'}</p>}
   </div></details>
   <details className="cash-disclosure"><summary><span>Pendientes e incidencias acumulados</span><span aria-hidden="true">+</span></summary><div className="cash-disclosure-body"><div className="cash-line"><span>Clientes con saldo pendiente</span><strong>{overview?money(overview.pending_cents):'—'}</strong></div><div className="cash-line"><span>Incidencias abiertas</span><strong>{overview?.open_issues??'—'}</strong></div><small>Estos datos incluyen jornadas anteriores.</small></div></details>
  </div>

  <div hidden={tab!=='drivers'||action!==null}>
   <UnifiedSettlement onChanged={()=>void load()} onSummary={onSettlementSummary} refreshSignal={refreshSignal} cashDayStatus={day?.status}/>
  </div>

  <div className="cash-history" hidden={tab!=='history'||action!==null}>
   <section className="cash-card"><div className="cash-section-head"><div><p className="cash-eyebrow">EFECTIVO RECIBIDO</p><h2>Últimas entregas</h2></div></div>
    {!handoffs.length?<p>No hay entregas registradas.</p>:<div className="cash-ledger">{handoffs.map(h=><details className="cash-ledger-entry" key={h.id}><summary><span><strong>{positions.find(p=>p.user_id===h.from_user_id)?.display_name||'Responsable'}</strong><small>{new Date(h.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></span><strong>{money(h.amount_cents)}</strong></summary><p>{h.note||'Sin nota.'}</p></details>)}</div>}
   </section>
   <details className="cash-disclosure"><summary><span>Cobros y entregas acumulados</span><span aria-hidden="true">+</span></summary><div className="cash-disclosure-body"><p>Son movimientos históricos, no el saldo del cajón ni una deuda del repartidor.</p>{positions.filter(x=>x.user_id!==currentUser).map(x=><div className="cash-history-person" key={x.user_id}><strong>{x.display_name}</strong><div className="cash-line"><span>Cobrado</span><span>{money(x.collected_cents)}</span></div><div className="cash-line"><span>Entregado</span><span>{money(x.handed_off_cents)}</span></div></div>)}{!positions.some(x=>x.user_id!==currentUser)&&<p>Sin movimientos registrados.</p>}</div></details>
   {day?.status==='open'&&<button className="cash-secondary" onClick={()=>setAction('handoff')}>Recibir efectivo de otro responsable →</button>}
  </div>

  <section className="cash-card cash-action-panel" hidden={action!=='handoff'} aria-label="Entrega de otro responsable">
   <div className="cash-section-head"><h2>Recibir efectivo</h2><button className="cash-text-button" onClick={()=>setAction(null)}>Volver</button></div>
   <p>Para cobros de otros responsables. Los repartidores usan su liquidación.</p>
   <label>Persona que entrega<select value={source} disabled={busy||!!attempt.current} onChange={e=>setSource(e.target.value)}><option value="">Seleccionar persona</option>{positions.filter(x=>x.user_id!==currentUser&&!driverIds.includes(x.user_id)&&Number(x.remaining_cents)>0).map(x=><option key={x.user_id} value={x.user_id}>{x.display_name} · {money(x.remaining_cents)}</option>)}</select></label>
   <label>Monto recibido (Q)<input inputMode="decimal" value={amount} disabled={busy||!!attempt.current} onChange={e=>setAmount(e.target.value)} placeholder="0.00"/></label>
   <label>Nota (opcional)<input maxLength={250} value={note} disabled={busy||!!attempt.current} onChange={e=>setNote(e.target.value)} placeholder="Motivo de la entrega"/></label>
   <button className="cash-primary" disabled={!canSubmit} onClick={()=>void submit()}>{busy?'Registrando…':'Confirmar efectivo recibido'}</button>
   {attempt.current&&<p className="cash-error">Resultado incierto. Conservamos los datos para reintentar sin duplicar.</p>}
  </section>
 </section>;
}
