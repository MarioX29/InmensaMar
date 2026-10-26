import { DriverErrands } from './DriverErrands';
import { DriverCashFloat } from './DriverCashFloat';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import './delivery.css';
import { DeliveryReturnsPanel } from './DeliveryReturnsPanel';
type Driver={user_id:string;display_name:string};
type Route={id:string;label:string;driver_id:string;created_at:string;dispatched_at:string|null;status:string};
type Order={id:string;customer_name:string;total_cents:number;status?:string};
type Assignment={order_id:string;route_id:string;stop_order:number};
type PaymentEvent={order_id:string;event_kind:'pending'|'payment';method:string;amount_cents:number;verified_at:string|null};
type ReadyOrder={order_id:string;customer_name:string;delivery_address:string;total_cents:number};
type DriverOrder={order_id:string;route_id:string;route_label:string;customer_name:string;customer_phone:string;delivery_address:string;total_cents:number;stop_order:number;order_status:string};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const GUATEMALA_TZ='America/Guatemala';
const formatLocalDate=(iso:string)=>new Intl.DateTimeFormat('es-GT',{timeZone:GUATEMALA_TZ,day:'2-digit',month:'2-digit',year:'numeric'}).format(new Date(iso));
const formatLocalDateTime=(iso:string)=>new Intl.DateTimeFormat('es-GT',{timeZone:GUATEMALA_TZ,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hour12:true}).format(new Date(iso));
const localDateKey=(iso:string)=>{const parts=new Intl.DateTimeFormat('en-CA',{timeZone:GUATEMALA_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));const part=(type:string)=>parts.find(x=>x.type===type)?.value||'';return `${part('year')}-${part('month')}-${part('day')}`;};
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar la operación.';
export function DeliveryPanel({staffRole='admin'}:{staffRole?:'admin'|'counter'|'driver'}) {
 const [drivers,setDrivers]=useState<Driver[]>([]);
 const [routes,setRoutes]=useState<Route[]>([]);
 const [orders,setOrders]=useState<Order[]>([]);
 const [assignments,setAssignments]=useState<Assignment[]>([]);
 const [mine,setMine]=useState<DriverOrder[]>([]);
 const [readyDriver,setReadyDriver]=useState<ReadyOrder[]>([]);
 const [driverSelected,setDriverSelected]=useState<string[]>([]);
 const [driverPending,setDriverPending]=useState<{requestId:string;orderIds:string[]}|null>(()=>{try{return JSON.parse(localStorage.getItem('im-driver-outing-pending')||'null');}catch{return null;}});
 const [failureReason,setFailureReason]=useState('absent');
 const [failureChoice,setFailureChoice]=useState<{orderId:string;action:'retry'|'return'}|null>(null);
 const [failurePending,setFailurePending]=useState<{requestId:string;orderId:string;action:'retry'|'return';reason:string}|null>(()=>{try{return JSON.parse(localStorage.getItem('im-failure-pending')||'null');}catch{return null;}});
 const [paymentEvents,setPaymentEvents]=useState<PaymentEvent[]>([]);
 const [paymentMethod,setPaymentMethod]=useState<'cash'|'transfer_reported'|'pending'>('cash');
 const [tendered,setTendered]=useState('');
 const paymentAttempt=useRef<{orderId:string;requestId:string;method:string;tenderedCents:number}|null>(null);
 const [orderStates,setOrderStates]=useState<Record<string,string>>({});
 const [driver,setDriver]=useState('');
 const [chosen,setChosen]=useState<string[]>([]);
 const [busy,setBusy]=useState(false);
 const [view,setView]=useState<'active'|'history'>('active');
 const [dateFrom,setDateFrom]=useState('');
 const [dateTo,setDateTo]=useState('');
 const [historyDriver,setHistoryDriver]=useState('all');
 const [historyStatus,setHistoryStatus]=useState('all');
 const [historySearch,setHistorySearch]=useState('');
 const [historySort,setHistorySort]=useState<'newest'|'oldest'>('newest');
 const [expandedRoute,setExpandedRoute]=useState<string|null>(null);
 const [confirm,setConfirm]=useState<{kind:'outing'|'delivery';id:string}|null>(null);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const attempt=useRef<{requestId:string;driverId:string;orderIds:string[]}|null>(null);
 const load=useCallback(async(forceSessionRefresh=false)=>{
  if(!supabase)return;
  // The browser can keep an old access token while a driver remains signed in.
  // Refresh on explicit request; otherwise let Supabase manage its normal session lifecycle.
  if(staffRole==='driver'){
   if(forceSessionRefresh){
    const {error:refreshError}=await supabase.auth.refreshSession();
    if(refreshError){setError(`No se pudo renovar la sesión: ${errorText(refreshError)}. Revisá tu conexión.`);return;}
   }
   const {data:sessionData,error:sessionError}=await supabase.auth.getSession();
   if(sessionError||!sessionData.session){setError('La sesión no está disponible. Volvé a iniciar sesión.');return;}
   let result=await supabase.rpc('my_delivery_orders_v2');
   if(result.error && /jwt|expired|unauthoriz|permission|token/i.test(errorText(result.error))){
    const refreshed=await supabase.auth.refreshSession();
    if(refreshed.error){setError(`No se pudo renovar la sesión: ${errorText(refreshed.error)}`);return;}
    result=await supabase.rpc('my_delivery_orders_v2');
   }
   if(result.error){setError(`No se pudieron actualizar las entregas: ${errorText(result.error)}`);return;}
   // Never hide an assigned delivery because the secondary payment lookup fails.
   const assigned=(result.data||[]) as DriverOrder[];
   setMine(assigned);
   setOrderStates(Object.fromEntries(assigned.map(x=>[x.order_id,x.order_status])));
   const readyResult=await supabase.rpc('driver_ready_orders');
   if(readyResult.error){setError(`No se pudieron consultar pedidos listos: ${errorText(readyResult.error)}`);return;}
   setReadyDriver((readyResult.data||[]) as ReadyOrder[]);
   const payments=await supabase.from('delivery_payment_events').select('order_id,event_kind,method,amount_cents,verified_at');
   if(payments.error){setError(`Entregas actualizadas, pero falló la consulta de pagos: ${errorText(payments.error)}`);return;}
   setPaymentEvents(payments.data||[]);
   setError('');
   return;
  }
  const [d,r,o,a,m,p]=await Promise.all([
   supabase.from('staff_profiles').select('user_id,display_name').in('role',['driver','admin']).eq('active',true),
   supabase.from('delivery_routes').select('id,label,driver_id,created_at,dispatched_at,status').order('created_at',{ascending:false}).limit(100),
   supabase.from('customer_orders').select('id,customer_name,total_cents,status').in('status',['ready','out_for_delivery','delivered','cancelled']).order('created_at',{ascending:false}).limit(100),
   supabase.from('delivery_assignments').select('order_id,route_id,stop_order').limit(500),
   supabase.rpc('my_delivery_orders_v2'),
   supabase.from('delivery_payment_events').select('order_id,event_kind,method,amount_cents,verified_at')
  ]);
  const issue=[d,r,o,a,p].find(x=>x.error)?.error;
  if(issue){setError(errorText(issue));return;}
  setDrivers(d.data||[]);setRoutes(r.data||[]);setOrders(o.data||[]);setAssignments(a.data||[]);setPaymentEvents(p.data||[]);
  setOrderStates(Object.fromEntries((o.data||[]).map(x=>[x.id,x.status])));
  if(!m.error)setMine(m.data||[]);
  setError('');
 },[staffRole]);
 useEffect(()=>{
  void load();
  if(staffRole!=='driver')return;
  const onFocus=()=>{if(document.visibilityState==='visible')void load();};
  window.addEventListener('focus',onFocus);
  document.addEventListener('visibilitychange',onFocus);
  const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load();},30000);
  return()=>{window.removeEventListener('focus',onFocus);document.removeEventListener('visibilitychange',onFocus);window.clearInterval(timer);};
 },[load,staffRole]);
 const available=orders.filter(o=>o.status==='ready'&&!assignments.some(a=>a.order_id===o.id));
 const selected=chosen.filter(id=>available.some(o=>o.id===id));
 async function prepare(){
  if(!supabase||busy||!driver||!selected.length)return;
  const ids=[...selected];
  if(attempt.current && (attempt.current.driverId!==driver || JSON.stringify(attempt.current.orderIds)!==JSON.stringify(ids))){
   setError('Hay una salida anterior sin confirmar. Actualizá y verificá antes de preparar otra.');return;
  }
  if(!attempt.current)attempt.current={requestId:crypto.randomUUID(),driverId:driver,orderIds:ids};
  setBusy(true);setError('');setNotice('');
  try{
   const {data,error:e}=await supabase.rpc('prepare_and_dispatch_outing',{
    p_request_id:attempt.current.requestId,p_driver_id:driver,p_order_ids:ids
   });
   if(e){setError(`${errorText(e)}. Si hubo un problema de conexión, no creés otra salida hasta verificar.`);return;}
   attempt.current=null;
   setChosen([]);
   setNotice(`Salida confirmada (${String(data).slice(0,8)}). ${ids.length} pedidos en reparto.`);
   await load();
  }catch(e){setError(`No se pudo confirmar la salida: ${errorText(e)}. No repitás con otra solicitud.`);}
  finally{setBusy(false);}
 }
 async function takeDriverOrders(){
  if(!supabase||busy)return;
  const ids=driverPending?.orderIds||driverSelected;
  if(!ids.length)return;
  const pending=driverPending||{requestId:crypto.randomUUID(),orderIds:[...ids]};
  if(!driverPending){localStorage.setItem('im-driver-outing-pending',JSON.stringify(pending));setDriverPending(pending);}
  setBusy(true);setError('');setNotice('');
  try{
   const {data,error:e}=await supabase.rpc('driver_take_ready_orders',{p_request_id:pending.requestId,p_order_ids:pending.orderIds});
   if(e){setError(`No se pudo confirmar la salida: ${errorText(e)}. Si hubo un corte de conexión, verificá la solicitud original antes de descartarla.`);return;}
   localStorage.removeItem('im-driver-outing-pending');setDriverPending(null);setDriverSelected([]);
   setNotice(`Salida confirmada (${String(data).slice(0,8)}). Ya podés repartir.`);await load();
  }catch(e){setError(`No pudimos confirmar la salida: ${errorText(e)}. No repitás con una solicitud nueva.`);}
  finally{setBusy(false);}
 }
 async function reorderDriver(order:DriverOrder,direction:number){
  if(!supabase||busy)return;
  const list=mine.filter(x=>x.route_id===order.route_id).sort((a,b)=>a.stop_order-b.stop_order);
  const ids=list.map(x=>x.order_id),i=ids.indexOf(order.order_id),j=i+direction;
  if(i<0||j<0||j>=ids.length)return;
  [ids[i],ids[j]]=[ids[j],ids[i]];setBusy(true);
  const {error:e}=await supabase.rpc('driver_reorder_active_route',{p_route_id:order.route_id,p_order_ids:ids});
  if(e)setError(errorText(e));else await load();setBusy(false);
 }
 async function move(routeId:string,orderId:string,direction:number){
  if(!supabase||busy)return;
  const ids=assignments.filter(a=>a.route_id===routeId).sort((a,b)=>a.stop_order-b.stop_order).map(a=>a.order_id);
  const i=ids.indexOf(orderId),j=i+direction;if(i<0||j<0||j>=ids.length)return;
  [ids[i],ids[j]]=[ids[j],ids[i]];
  setBusy(true);setError('');
  const {error:e}=await supabase.rpc('reorder_delivery_route',{p_route_id:routeId,p_order_ids:ids});
  if(e)setError(errorText(e));else await load();
  setBusy(false);
 }
 async function dispatch(routeId:string){
  if(!supabase||busy)return;
  setBusy(true);setError('');
  const {error:e}=await supabase.rpc('dispatch_delivery_route',{p_route_id:routeId});
  if(e)setError(errorText(e)+' Si no estás seguro del resultado, actualizá antes de intentar otra vez.');
  else {setNotice('Salida despachada. El inventario reservado fue descontado.');await load();}
  setBusy(false);
 }
 async function delivered(orderId:string, totalCents:number){
  if(!supabase||busy)return;
  const cents=paymentMethod==='cash'?Math.round(Number(tendered)*100):0;
  if(paymentMethod==='cash'&&(!tendered.trim()||!Number.isFinite(Number(tendered))||cents<totalCents||!Number.isSafeInteger(cents))){setError('Ingresá el efectivo recibido, igual o mayor al total.');return;}
  const previous=paymentAttempt.current;
  if(previous&&(previous.orderId!==orderId||previous.method!==paymentMethod||previous.tenderedCents!==cents)){
   setError('Hay un cobro con resultado incierto. Actualizá y verificá antes de cambiar los datos.');return;
  }
  const attempt=previous||{orderId,requestId:crypto.randomUUID(),method:paymentMethod,tenderedCents:cents};
  paymentAttempt.current=attempt;
  setBusy(true);setError('');
  try {
   const {error:e}=await supabase.rpc('confirm_delivery_with_payment',{
    p_order_id:orderId,p_request_id:attempt.requestId,p_method:attempt.method,
    p_cash_tendered_cents:attempt.tenderedCents,p_cash_received_by:null
   });
   if(e){setError(errorText(e)+' Si hubo un error de conexión, actualizá y verificá el cobro antes de reintentar.');return;}
   paymentAttempt.current=null;setConfirm(null);setTendered('');setPaymentMethod('cash');
   setNotice('Entrega y estado de cobro registrados. Transferencias reportadas requieren verificación.');
   await load();
  }catch(e){setError(errorText(e)+' Verificá antes de reintentar.');}
  finally{setBusy(false);}
 }
 async function reportFailure(){
  if(!supabase||busy)return;
  const p=failurePending||(failureChoice?{requestId:crypto.randomUUID(),orderId:failureChoice.orderId,action:failureChoice.action,reason:failureReason}:null);
  if(!p)return;
  if(!failurePending){localStorage.setItem('im-failure-pending',JSON.stringify(p));setFailurePending(p);}
  setBusy(true);setError('');
  try{const {error:e}=await supabase.rpc('report_delivery_failure',{p_order_id:p.orderId,p_request_id:p.requestId,p_action:p.action,p_reason:p.reason});
   if(e){setError(errorText(e)+' Verificá la misma solicitud antes de repetir.');return;}
   localStorage.removeItem('im-failure-pending');setFailurePending(null);setFailureChoice(null);setNotice(p.action==='retry'?'Intento registrado. Podés volver a entregar más tarde.':'Regreso solicitado. Mostrador debe confirmar la mercadería.');await load();
  }catch(e){setError(errorText(e)+' No iniciés otra operación.');}finally{setBusy(false);}
 }
 const hasPayment=(orderId:string)=>paymentEvents.some(e=>e.order_id===orderId&&e.event_kind==='payment');
 const pendingLate=orders.filter(o=>o.status==='delivered'&&!hasPayment(o.id)&&paymentEvents.some(e=>e.order_id===o.id&&e.event_kind==='pending'));
 return <section className="delivery-module">
  <details className="feature-note"><summary>Cómo registrar salidas y cobros</summary><p>Confirmar salida registra la salida física del producto. Al entregar, registrá efectivo, transferencia reportada o pago pendiente. Una transferencia reportada requiere verificación.</p></details>
  {error&&<div className="delivery-error" role="alert"><span>{error}</span><button onClick={()=>setError('')}>Cerrar</button></div>}
  {notice&&<div className="delivery-success" role="status"><span>{notice}</span><button onClick={()=>setNotice('')}>Cerrar</button></div>}
  {staffRole==='driver'&&<section className="delivery-card">
   <div className="delivery-card-head"><h2>Pedidos listos para llevar</h2><button disabled={busy} onClick={()=>void load()}>Actualizar</button></div>
   <p className="delivery-subtitle">Elegí los pedidos y salí directo. Si otro repartidor los toma, Supabase rechazará toda la salida.</p>
   {readyDriver.length===0?<p>No hay pedidos disponibles.</p>:readyDriver.map(o=><label className="delivery-order" key={o.order_id}>
    <input type="checkbox" checked={driverSelected.includes(o.order_id)} disabled={busy||!!driverPending} onChange={e=>setDriverSelected(old=>e.target.checked?[...old,o.order_id]:old.filter(id=>id!==o.order_id))}/>
    <span><strong>{o.customer_name}</strong><small>{o.delivery_address}</small></span><b>{money(o.total_cents)}</b>
   </label>)}
   <div className="delivery-summary"><span>{(driverPending?.orderIds||driverSelected).length} seleccionados</span><strong>{money(readyDriver.filter(o=>(driverPending?.orderIds||driverSelected).includes(o.order_id)).reduce((sum,o)=>sum+o.total_cents,0))}</strong></div>
   {driverPending&&<p role="alert" className="delivery-warning">Operación por verificar. No iniciés otra salida. Reintentá con la misma solicitud para comprobar si ya se registró.</p>}
   <button className="delivery-primary" disabled={busy||!(driverPending?.orderIds||driverSelected).length} onClick={()=>void takeDriverOrders()}>{busy?'Procesando…':driverPending?'Verificar misma salida':'Tomar pedidos y salir'}</button>
  </section>}
  {staffRole==='driver'&&<details className="work-disclosure"><summary><strong>Mi sencillo y mis compras</strong><span>Ver y registrar →</span></summary><div className="work-disclosure-body"><DriverCashFloat/><DriverErrands/></div></details>}
  {staffRole!=='driver'&&<div className="delivery-tabs" role="group" aria-label="Vistas de reparto"><button type="button" className={view==='active'?'selected':''} aria-pressed={view==='active'} onClick={()=>setView('active')}>En reparto</button><button type="button" className={view==='history'?'selected':''} aria-pressed={view==='history'} onClick={()=>setView('history')}>Historial</button></div>}
  {staffRole!=='driver'&&view==='active'&&<details className="work-disclosure delivery-new-outing"><summary><strong>Preparar una salida</strong><span>{available.length} pedidos listos · Preparar →</span></summary><section className="delivery-card">
   <div className="delivery-card-head"><h2>Nueva salida</h2><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
   <p className="delivery-subtitle">Elegí quién sale y marcá los pedidos listos.</p>
   <fieldset className="delivery-drivers"><legend>¿Quién va a repartir?</legend>
    {drivers.map((d,i)=><label className="delivery-driver" key={d.user_id}>
     <input type="radio" name="delivery-driver" value={d.user_id} checked={driver===d.user_id} disabled={busy||!!attempt.current} onChange={()=>setDriver(d.user_id)}/>
     <span>Repartidor {i+1} <small>{d.display_name}</small></span>
    </label>)}
    {!drivers.length&&<p>No hay repartidores activos. Para pruebas podés usar un administrador activo.</p>}
   </fieldset>
   <h3>Pedidos listos</h3>
   {!available.length?<p>No hay pedidos listos sin asignar.</p>:available.map(o=><label className="delivery-order" key={o.id}>
    <input type="checkbox" checked={selected.includes(o.id)} disabled={busy||!!attempt.current} onChange={e=>setChosen(old=>e.target.checked?[...old,o.id]:old.filter(x=>x!==o.id))}/>
    <span><strong>Pedido #{o.id.slice(0,8)}</strong><small>{o.customer_name}</small></span>
    <b>{money(o.total_cents)}</b>
   </label>)}
   <div className="delivery-summary"><span>{selected.length} pedidos seleccionados</span><strong>{drivers.find(d=>d.user_id===driver)?.display_name||'Elegí repartidor'}</strong></div>
   <button className="delivery-primary" disabled={busy||!driver||!selected.length} onClick={()=>setConfirm({kind:'outing',id:'new'})}>{busy?'Confirmando…':attempt.current?'Verificar misma salida':'Confirmar salida'}</button>
   {attempt.current&&<p className="delivery-subtitle">La última solicitud tiene un resultado incierto. Este botón utiliza el mismo identificador para evitar duplicarla.</p>}
  </section></details>}
  {staffRole!=='driver'&&view==='active'&&<section className="delivery-card"><h2>Salidas en curso</h2>
   {!routes.some(r=>r.status!=='closed' && (r.dispatched_at || assignments.some(a=>a.route_id===r.id && orderStates[a.order_id]!=='cancelled')))&&<p>No hay salidas en curso.</p>}
   {routes.filter(r=>r.status!=='closed' && (r.dispatched_at || assignments.some(a=>a.route_id===r.id && orderStates[a.order_id]!=='cancelled'))).map(r=>{
    const assigned=assignments.filter(a=>a.route_id===r.id).sort((a,b)=>a.stop_order-b.stop_order);
    return <div className="delivery-route" key={r.id}><strong>{r.label}</strong><small>{drivers.find(d=>d.user_id===r.driver_id)?.display_name||'Repartidor'} · {assigned.length} pedidos · {r.dispatched_at?'En reparto':'Preparada'}</small>
     {assigned.map((a,i)=><div className="delivery-stop" key={a.order_id}><span>{i+1}. Pedido #{a.order_id.slice(0,8)} · {orderStates[a.order_id]==='delivered'?'Entregado':orderStates[a.order_id]==='out_for_delivery'?'En reparto':orderStates[a.order_id]==='cancelled'?'Cancelado':'Listo'}</span><div><button disabled={busy||!!r.dispatched_at||i===0} aria-label="Subir parada" onClick={()=>void move(r.id,a.order_id,-1)}>↑</button><button disabled={busy||!!r.dispatched_at||i===assigned.length-1} aria-label="Bajar parada" onClick={()=>void move(r.id,a.order_id,1)}>↓</button></div></div>)}
     {!r.dispatched_at&&r.status==='planning'&&assigned.length>0&&<button className="delivery-primary" disabled={busy} onClick={()=>setConfirm({kind:'outing',id:r.id})}>Confirmar despacho</button>}
    </div>;
   })}
  </section>}
  {staffRole!=='driver'&&view==='history'&&<section className="delivery-card"><div className="delivery-card-head"><h2>Historial de reparto</h2><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
   <p className="delivery-subtitle">Consultá salidas cerradas por fecha y repartidor. Se muestran hasta las 100 salidas más recientes cargadas; los filtros no son un reporte completo de períodos anteriores.</p>
   <details className="filter-disclosure"><summary>Filtrar historial</summary><div className="delivery-filters">
    <label>Desde<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
    <label>Hasta<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
    <label>Repartidor<select value={historyDriver} onChange={e=>setHistoryDriver(e.target.value)}><option value="all">Todos</option>{drivers.map(d=><option key={d.user_id} value={d.user_id}>{d.display_name}</option>)}</select></label>
    <label>Estado<select value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">Todos</option><option value="delivered">Entregadas</option><option value="cancelled">Canceladas</option><option value="other">Otras cerradas</option></select></label>
    <label>Orden<select value={historySort} onChange={e=>{const value=e.target.value;if(value==='newest'||value==='oldest')setHistorySort(value);}}><option value="newest">Más recientes</option><option value="oldest">Más antiguas</option></select></label>
    <label>Buscar<input type="search" placeholder="Número de pedido o salida" value={historySearch} onChange={e=>setHistorySearch(e.target.value)}/></label>
   </div></details>
   {(()=>{
    const filtered=routes.filter(r=>r.status==='closed').filter(r=>{
     const ids=assignments.filter(a=>a.route_id===r.id).map(a=>a.order_id);
     const states=ids.map(id=>orderStates[id]);
     const state=states.length>0&&states.every(x=>x==='delivered')?'delivered':states.length>0&&states.every(x=>x==='cancelled')?'cancelled':'other';
     const day=localDateKey(r.created_at);
     return (!dateFrom||day>=dateFrom)&&(!dateTo||day<=dateTo)&&(historyDriver==='all'||r.driver_id===historyDriver)&&(historyStatus==='all'||state===historyStatus)&&(!historySearch||`${r.label} ${r.id} ${ids.join(' ')}`.toLowerCase().includes(historySearch.toLowerCase()));
    }).sort((a,b)=>historySort==='newest'?b.created_at.localeCompare(a.created_at):a.created_at.localeCompare(b.created_at));
    return <>
     <p className="delivery-subtitle">{filtered.length} salidas encontradas en los registros cargados.</p>
     {!filtered.length?<p>No hay salidas con estos filtros.</p>:
      <div className="delivery-history-table-wrap">
       <table className="delivery-history-table">
        <thead><tr><th scope="col">Salida</th><th scope="col">Repartidor</th><th scope="col">Pedidos</th><th scope="col">Estado</th><th scope="col">Detalle</th></tr></thead>
        <tbody>{filtered.map(r=>{
         const assigned=assignments.filter(a=>a.route_id===r.id).sort((a,b)=>a.stop_order-b.stop_order);
         const states=assigned.map(a=>orderStates[a.order_id]);
         const label=states.length>0&&states.every(x=>x==='delivered')?'Entregada':states.length>0&&states.every(x=>x==='cancelled')?'Cancelada':'Cerrada';
         const isOpen=expandedRoute===r.id;
         return <Fragment key={r.id}>
           <tr className={isOpen?'delivery-history-open':''}>
            <td><strong>Salida #{r.id.slice(0,8)}</strong><small>{formatLocalDateTime(r.created_at)}</small></td>
            <td>{drivers.find(d=>d.user_id===r.driver_id)?.display_name||'Repartidor'}</td>
            <td>{assigned.length}</td>
            <td><span className="delivery-history-status">{label}</span></td>
            <td><button type="button" className="delivery-history-detail-button" aria-expanded={isOpen} onClick={()=>setExpandedRoute(isOpen?null:r.id)}>{isOpen?'Ocultar':'Ver detalles'}</button></td>
           </tr>
           {isOpen&&<tr className="delivery-history-detail-row"><td colSpan={5}>
            <div className="delivery-history-full-detail">
             <strong>Pedidos de esta salida</strong>
             {assigned.map(a=>{
              const o=orders.find(item=>item.id===a.order_id);
              return <div key={a.order_id} className="delivery-history-order-detail">
               <span>#{a.order_id.slice(0,8)} · {o?.customer_name||'Cliente no cargado'}</span>
               <span>{orderStates[a.order_id]==='delivered'?'Entregado':orderStates[a.order_id]==='cancelled'?'Cancelado':orderStates[a.order_id]||'Estado no cargado'}</span>
               <strong>{o?money(o.total_cents):'—'}</strong>
              </div>;
             })}
             <small>Creada: {formatLocalDateTime(r.created_at)}{r.dispatched_at?` · Despachada: ${formatLocalDateTime(r.dispatched_at)}`:''}</small>
             <small>Horarios de Guatemala. Los importes corresponden a pedidos, no a cobros confirmados.</small>
            </div>
           </td></tr>}
          </Fragment>;
        })}</tbody>
       </table>
      </div>}
    </>;
   })()}
  </section>}
  {mine.length>0&&(staffRole==='driver'||view==='active')&&<section className="delivery-card"><h2>Mis entregas asignadas</h2>{mine.map(o=><div className="delivery-route" key={o.order_id}>
   <strong>{o.stop_order}. {o.customer_name}</strong><small>{o.route_label} · {o.delivery_address}</small><small>{o.customer_phone} · {money(o.total_cents)}</small>
   <div className="driver-links"><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.delivery_address)}`}>Google Maps</a><a target="_blank" rel="noopener noreferrer" href={`https://waze.com/ul?q=${encodeURIComponent(o.delivery_address)}&navigate=yes`}>Waze</a></div>
   {staffRole==='driver'&&orderStates[o.order_id]==='out_for_delivery'&&<div className="driver-order-actions"><button disabled={busy} onClick={()=>void reorderDriver(o,-1)}>Subir</button><button disabled={busy} onClick={()=>void reorderDriver(o,1)}>Bajar</button></div>}
   {orderStates[o.order_id]==='out_for_delivery'&&<button type="button" disabled={busy||!!failurePending} onClick={()=>{setFailureReason('absent');setFailureChoice({orderId:o.order_id,action:'retry'});}}>No se pudo entregar</button>}
   {orderStates[o.order_id]==='out_for_delivery'&&<button className="delivery-primary" disabled={busy} onClick={()=>{setPaymentMethod('cash');setTendered('');setConfirm({kind:'delivery',id:o.order_id});}}>Marcar entregado</button>}
  </div>)}</section>}

  {staffRole!=='driver'&&view==='active'&&<DeliveryReturnsPanel/>}
  {(failureChoice||failurePending)&&staffRole==='driver'&&<div className="delivery-confirm-backdrop"><div className="delivery-confirm-dialog" role="dialog" aria-modal="true" aria-label="Entrega fallida"><h3>No se pudo entregar</h3><p>Registrá el motivo y decidí si vas a intentar más tarde o regresar al local.</p><label>Motivo<select value={failurePending?.reason||failureReason} disabled={busy||!!failurePending} onChange={e=>setFailureReason(e.target.value)}><option value="absent">Cliente ausente</option><option value="no_answer">No responde</option><option value="wrong_address">Dirección incorrecta</option><option value="rejected">Cliente rechazó</option><option value="other">Otro</option></select></label><div className="delivery-confirm-actions"><button disabled={busy||!!failurePending} onClick={()=>setFailureChoice(null)}>Volver</button><button disabled={busy||!!failurePending} onClick={()=>setFailureChoice(v=>v?{...v,action:'retry'}:v)}>Intentar más tarde</button><button disabled={busy||!!failurePending} onClick={()=>setFailureChoice(v=>v?{...v,action:'return'}:v)}>Regresar al local</button></div><p>Acción: {failurePending?.action==='return'||!failurePending&&failureChoice?.action==='return'?'Regresar al local':'Intentar más tarde'}</p><button className="delivery-primary" disabled={busy} onClick={()=>void reportFailure()}>{failurePending?'Verificar misma operación':'Confirmar'}</button></div></div>}
  {staffRole==='driver'&&mine.length>0&&<section className="delivery-card"><h2>Resumen de cobros</h2>
   <p className="delivery-subtitle">Montos de mis pedidos visibles. Las transferencias reportadas requieren verificación.</p>
   <div className="delivery-summary"><span>Pedidos en mi lista</span><strong>{mine.length}</strong></div>
   <div className="delivery-summary"><span>Valor de pedidos</span><strong>{money(mine.reduce((n,o)=>n+o.total_cents,0))}</strong></div>
   <div className="delivery-summary"><span>Efectivo registrado</span><strong>{money(mine.reduce((n,o)=>n+paymentEvents.filter(e=>e.order_id===o.order_id&&e.event_kind==='payment'&&e.method==='cash').reduce((a,e)=>a+e.amount_cents,0),0))}</strong></div>
   <div className="delivery-summary"><span>Transferencias reportadas</span><strong>{money(mine.reduce((n,o)=>n+paymentEvents.filter(e=>e.order_id===o.order_id&&e.event_kind==='payment'&&e.method==='transfer_reported').reduce((a,e)=>a+e.amount_cents,0),0))}</strong></div>
   <p className="delivery-subtitle">Este resumen no sustituye la liquidación de efectivo y no incluye entregas fuera de la lista actual.</p>
  </section>}
  {staffRole!=='driver'&&view==='active'&&pendingLate.length>0&&<section className="delivery-card"><h2>Cobros pendientes después de la entrega</h2><p className="delivery-subtitle">Solo pedidos entregados con un pendiente registrado.</p>{pendingLate.map(o=><div className="delivery-route" key={o.id}><strong>Pedido #{o.id.slice(0,8)} · {o.customer_name}</strong><small>{money(o.total_cents)} pendiente</small><button className="delivery-primary" disabled={busy} onClick={()=>{setPaymentMethod('cash');setTendered('');setConfirm({kind:'delivery',id:o.id});}}>Registrar cobro posterior</button></div>)}</section>}
  {confirm&&<div className="delivery-confirm-backdrop" role="presentation">
   <div className="delivery-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-confirm-title">
    <h3 id="delivery-confirm-title">{confirm.kind==='delivery'?(orderStates[confirm.id]==='delivered'?'¿Registrar cobro pendiente?':'¿Entregar y registrar cobro?'):'¿Confirmar salida?'}</h3>
    <p>{confirm.kind==='delivery'?'Elegí cómo pagó el cliente. Las transferencias quedan reportadas hasta su verificación.':'Confirmá que los productos salieron del local. Esta acción descuenta el inventario reservado.'}</p>
    {confirm.kind==='delivery'&&(()=>{
      const order=mine.find(o=>o.order_id===confirm.id)||orders.find(o=>o.id===confirm.id);
      const total=order?.total_cents??0;
      const cashNumber=Number(tendered);
      const validCash=tendered.trim()!==''&&Number.isFinite(cashNumber)&&Number.isSafeInteger(Math.round(cashNumber*100))&&Math.round(cashNumber*100)>=total;
      const isLate=orderStates[confirm.id]==='delivered';
      return <div className="delivery-payment-fields">
        <div className="delivery-payment-total"><span>Total del pedido</span><strong>{money(total)}</strong></div>
        <fieldset className="delivery-payment-methods"><legend>¿Cómo pagó el cliente?</legend>
          <label><input type="radio" name="delivery-payment-method" value="cash" checked={paymentMethod==='cash'} disabled={busy||!!paymentAttempt.current} onChange={()=>setPaymentMethod('cash')}/> Efectivo</label>
          <label><input type="radio" name="delivery-payment-method" value="transfer_reported" checked={paymentMethod==='transfer_reported'} disabled={busy||!!paymentAttempt.current} onChange={()=>setPaymentMethod('transfer_reported')}/> Transferencia reportada</label>
          {!isLate&&<label><input type="radio" name="delivery-payment-method" value="pending" checked={paymentMethod==='pending'} disabled={busy||!!paymentAttempt.current} onChange={()=>setPaymentMethod('pending')}/> Pago pendiente</label>}
        </fieldset>
        {paymentMethod==='cash'?<div className="delivery-payment-cash">
          <label htmlFor="delivery-tendered">Efectivo recibido (Q)</label>
          <input id="delivery-tendered" type="number" inputMode="decimal" min="0" step="0.01" placeholder="Ej. 50.00" value={tendered} disabled={busy||!!paymentAttempt.current} onChange={e=>setTendered(e.target.value)}/>
          <div className="delivery-payment-change"><span>Cambio a devolver</span><strong>{validCash?money(Math.round(cashNumber*100)-total):'—'}</strong></div>
          {tendered.trim()!==''&&!validCash&&<small role="alert">Ingresá un monto igual o mayor al total.</small>}
        </div>:<p className="delivery-payment-note">{paymentMethod==='transfer_reported'?'La transferencia quedará pendiente de verificación bancaria por el administrador.':'El pedido se entregará con saldo pendiente, sin registrar dinero recibido.'}</p>}
      </div>;
    })()}
    <div className="delivery-confirm-actions">
     <button type="button" disabled={busy} onClick={()=>{if(!paymentAttempt.current)setConfirm(null);}}>Volver</button>
     <button type="button" className="delivery-primary" disabled={busy||(confirm.kind==='delivery'&&(paymentMethod==='cash'&&(!tendered.trim()||!Number.isFinite(Number(tendered))||!Number.isSafeInteger(Math.round(Number(tendered)*100))||Math.round(Number(tendered)*100)<(mine.find(o=>o.order_id===confirm.id)?.total_cents??orders.find(o=>o.id===confirm.id)?.total_cents??0))||orderStates[confirm.id]==='delivered'&&paymentMethod==='pending'))} onClick={()=>{
      const action=confirm;
      if(action.kind==='delivery')void delivered(action.id,mine.find(o=>o.order_id===action.id)?.total_cents||orders.find(o=>o.id===action.id)?.total_cents||0);
      else if(action.id==='new')void prepare();
      else void dispatch(action.id);
     }}>{busy?'Procesando…':'Sí, confirmar'}</button>
    </div>
   </div>
  </div>}
 </section>;
}