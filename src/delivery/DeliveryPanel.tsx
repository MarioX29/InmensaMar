import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import './delivery.css';
type Driver={user_id:string;display_name:string};
type Route={id:string;label:string;driver_id:string;created_at:string;dispatched_at:string|null;status:string};
type Order={id:string;customer_name:string;total_cents:number;status?:string};
type Assignment={order_id:string;route_id:string;stop_order:number};
type DriverOrder={order_id:string;route_id:string;route_label:string;customer_name:string;customer_phone:string;delivery_address:string;total_cents:number;stop_order:number;order_status:string};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const errorText=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar la operación.';
export function DeliveryPanel({staffRole='admin'}:{staffRole?:'admin'|'counter'|'driver'}) {
 const [drivers,setDrivers]=useState<Driver[]>([]);
 const [routes,setRoutes]=useState<Route[]>([]);
 const [orders,setOrders]=useState<Order[]>([]);
 const [assignments,setAssignments]=useState<Assignment[]>([]);
 const [mine,setMine]=useState<DriverOrder[]>([]);
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
 const load=useCallback(async()=>{
  if(!supabase)return;
  if(staffRole==='driver'){
   const result=await supabase.rpc('my_delivery_orders_v2');
   if(result.error)setError(errorText(result.error));else {setMine(result.data||[]);setOrderStates(Object.fromEntries((result.data||[]).map((x:DriverOrder)=>[x.order_id,x.order_status])));setError('');}
   return;
  }
  const [d,r,o,a,m]=await Promise.all([
   supabase.from('staff_profiles').select('user_id,display_name').in('role',['driver','admin']).eq('active',true),
   supabase.from('delivery_routes').select('id,label,driver_id,created_at,dispatched_at,status').order('created_at',{ascending:false}).limit(100),
   supabase.from('customer_orders').select('id,customer_name,total_cents,status').in('status',['ready','out_for_delivery','delivered','cancelled']).order('created_at',{ascending:false}).limit(100),
   supabase.from('delivery_assignments').select('order_id,route_id,stop_order').limit(500),
   supabase.rpc('my_delivery_orders_v2')
  ]);
  const issue=[d,r,o,a].find(x=>x.error)?.error;
  if(issue){setError(errorText(issue));return;}
  setDrivers(d.data||[]);setRoutes(r.data||[]);setOrders(o.data||[]);setAssignments(a.data||[]);
  setOrderStates(Object.fromEntries((o.data||[]).map(x=>[x.id,x.status])));
  if(!m.error)setMine(m.data||[]);
  setError('');
 },[staffRole]);
 useEffect(()=>{void load();},[load]);
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
 async function delivered(orderId:string){
  if(!supabase||busy)return;
  setBusy(true);setError('');
  const {error:e}=await supabase.rpc('confirm_delivery',{p_order_id:orderId});
  if(e)setError(errorText(e));else {setNotice('Entrega confirmada. El pago sigue pendiente de registrar.');await load();}
  setBusy(false);
 }
 return <section className="delivery-module">
  <p className="delivery-warning">Confirmar salida asigna los pedidos y registra su salida física. Marcar entregado no registra ningún pago.</p>
  {error&&<div className="delivery-error" role="alert"><span>{error}</span><button onClick={()=>setError('')}>Cerrar</button></div>}
  {notice&&<div className="delivery-success" role="status"><span>{notice}</span><button onClick={()=>setNotice('')}>Cerrar</button></div>}
  {staffRole!=='driver'&&<div className="delivery-tabs" role="group" aria-label="Vistas de reparto"><button type="button" className={view==='active'?'selected':''} aria-pressed={view==='active'} onClick={()=>setView('active')}>En reparto</button><button type="button" className={view==='history'?'selected':''} aria-pressed={view==='history'} onClick={()=>setView('history')}>Historial</button></div>}
  {staffRole!=='driver'&&view==='active'&&<section className="delivery-card">
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
  </section>}
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
   <div className="delivery-filters">
    <label>Desde<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
    <label>Hasta<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
    <label>Repartidor<select value={historyDriver} onChange={e=>setHistoryDriver(e.target.value)}><option value="all">Todos</option>{drivers.map(d=><option key={d.user_id} value={d.user_id}>{d.display_name}</option>)}</select></label>
    <label>Estado<select value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">Todos</option><option value="delivered">Entregadas</option><option value="cancelled">Canceladas</option><option value="other">Otras cerradas</option></select></label>
    <label>Orden<select value={historySort} onChange={e=>setHistorySort(e.target.value)}><option value="newest">Más recientes</option><option value="oldest">Más antiguas</option></select></label>
    <label>Buscar<input type="search" placeholder="Número de pedido o salida" value={historySearch} onChange={e=>setHistorySearch(e.target.value)}/></label>
   </div>
   {(()=>{
    const filtered=routes.filter(r=>r.status==='closed').filter(r=>{
     const ids=assignments.filter(a=>a.route_id===r.id).map(a=>a.order_id);
     const states=ids.map(id=>orderStates[id]);
     const state=states.length>0&&states.every(x=>x==='delivered')?'delivered':states.length>0&&states.every(x=>x==='cancelled')?'cancelled':'other';
     const day=r.created_at.slice(0,10);
     return (!dateFrom||day>=dateFrom)&&(!dateTo||day<=dateTo)&&(historyDriver==='all'||r.driver_id===historyDriver)&&(historyStatus==='all'||state===historyStatus)&&(!historySearch||`${r.label} ${r.id} ${ids.join(' ')}`.toLowerCase().includes(historySearch.toLowerCase()));
    }).sort((a,b)=>historySort==='newest'?b.created_at.localeCompare(a.created_at):a.created_at.localeCompare(b.created_at));
    return <><p className="delivery-subtitle">{filtered.length} salidas encontradas en los registros cargados.</p>{!filtered.length&&<p>No hay salidas con estos filtros.</p>}{filtered.map(r=>{
     const assigned=assignments.filter(a=>a.route_id===r.id).sort((a,b)=>a.stop_order-b.stop_order);
     const states=assigned.map(a=>orderStates[a.order_id]);
     const label=states.length&&states.every(x=>x==='delivered')?'Entregada':states.length&&states.every(x=>x==='cancelled')?'Cancelada':'Cerrada';
     return <div className="delivery-history-item" key={r.id}><button type="button" className="delivery-history-toggle" aria-expanded={expandedRoute===r.id} onClick={()=>setExpandedRoute(expandedRoute===r.id?null:r.id)}><span><strong>{r.label}</strong><small>{new Date(r.created_at).toLocaleString('es-GT')} · {drivers.find(d=>d.user_id===r.driver_id)?.display_name||'Repartidor'} · {assigned.length} pedidos</small></span><span>{label} {expandedRoute===r.id?'▲':'▼'}</span></button>{expandedRoute===r.id&&<div className="delivery-history-detail">{assigned.map(a=><div key={a.order_id}>Pedido #{a.order_id.slice(0,8)} · {orderStates[a.order_id]==='delivered'?'Entregado':orderStates[a.order_id]==='cancelled'?'Cancelado':orderStates[a.order_id]||'Sin estado cargado'}</div>)}</div>}</div>;
    })}</>;
   })()}
  </section>}
  {mine.length>0&&(staffRole==='driver'||view==='active')&&<section className="delivery-card"><h2>Mis entregas asignadas</h2>{mine.map(o=><div className="delivery-route" key={o.order_id}>
   <strong>{o.stop_order}. {o.customer_name}</strong><small>{o.route_label} · {o.delivery_address}</small><small>{o.customer_phone} · {money(o.total_cents)}</small>
   <a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.delivery_address)}`}>Abrir dirección en Maps</a>
   {orderStates[o.order_id]==='out_for_delivery'&&<button className="delivery-primary" disabled={busy} onClick={()=>setConfirm({kind:'delivery',id:o.order_id})}>Marcar entregado</button>}
  </div>)}</section>}

  {confirm&&<div className="delivery-confirm-backdrop" role="presentation">
   <div className="delivery-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delivery-confirm-title">
    <h3 id="delivery-confirm-title">{confirm.kind==='delivery'?'¿Marcar pedido como entregado?':'¿Confirmar salida?'}</h3>
    <p>{confirm.kind==='delivery'?'Confirmá que el cliente recibió el pedido. Esto no registra ningún cobro.':'Confirmá que los productos salieron del local. Esta acción descuenta el inventario reservado.'}</p>
    <div className="delivery-confirm-actions">
     <button type="button" disabled={busy} onClick={()=>setConfirm(null)}>Volver</button>
     <button type="button" className="delivery-primary" disabled={busy} onClick={()=>{
      const action=confirm;setConfirm(null);
      if(action.kind==='delivery')void delivered(action.id);
      else if(action.id==='new')void prepare();
      else void dispatch(action.id);
     }}>{busy?'Procesando…':'Sí, confirmar'}</button>
    </div>
   </div>
  </div>}
 </section>;
}
