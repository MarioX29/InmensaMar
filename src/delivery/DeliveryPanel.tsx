import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './delivery.css';
type Driver={user_id:string;display_name:string};
type Route={id:string;label:string;driver_id:string};
type Order={id:string;customer_name:string;status:string;total_cents:number};
type Assignment={order_id:string;route_id:string;stop_order:number};
type DriverOrder={order_id:string;route_label:string;customer_name:string;customer_phone:string;delivery_address:string;total_cents:number;stop_order:number};
const err=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar la operación.';
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
export function DeliveryPanel({staffRole='admin'}:{staffRole?:'admin'|'counter'|'driver'}){
 const [drivers,setDrivers]=useState<Driver[]>([]);const [routes,setRoutes]=useState<Route[]>([]);
 const [orders,setOrders]=useState<Order[]>([]);const [assignments,setAssignments]=useState<Assignment[]>([]);
 const [mine,setMine]=useState<DriverOrder[]>([]);const [label,setLabel]=useState('Ruta de prueba');
 const [driver,setDriver]=useState('');const [selected,setSelected]=useState('');const [chosen,setChosen]=useState<string[]>([]);const [busy,setBusy]=useState(false);
 const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const load=useCallback(async()=>{
  if(!supabase)return;
  const [d,r,o,a,m]=await Promise.all([
   supabase.from('staff_profiles').select('user_id,display_name').in('role',['driver','admin']).eq('active',true),
   supabase.from('delivery_routes').select('id,label,driver_id').order('created_at',{ascending:false}).limit(100),
   supabase.from('customer_orders').select('id,customer_name,status,total_cents').eq('status','ready').order('created_at',{ascending:false}).limit(100),
   supabase.from('delivery_assignments').select('order_id,route_id,stop_order').limit(200),
   supabase.rpc('my_delivery_orders')
  ]);
  // Driver role is intentionally denied staff/order queries; show assigned orders only.
  if(!d.error)setDrivers(d.data||[]);
  if(!r.error)setRoutes(r.data||[]);
  if(!o.error)setOrders(o.data||[]);
  if(!a.error)setAssignments(a.data||[]);
  if(!m.error)setMine(m.data||[]);
  if(staffRole!=='driver'&&r.error)setError(err(r.error));
  if(staffRole==='driver'&&m.error)setError(err(m.error));
 },[]);
 useEffect(()=>{void load();},[load]);
 async function create(){if(!supabase||busy||!driver)return;setBusy(true);setError('');setNotice('');
  const {error:e}=await supabase.rpc('create_delivery_route',{p_label:label,p_driver_id:driver});
  if(e)setError(err(e));else setNotice('Ruta creada. Ahora podés asignar pedidos listos.');
  await load();setBusy(false);
 }
 async function assignSelected(){if(!supabase||busy||!selected||!chosen.length)return;setBusy(true);setError('');setNotice('');
  let completed=0;for(const orderId of chosen){const {error:e}=await supabase.rpc('assign_ready_order',{p_order_id:orderId,p_route_id:selected});if(e){setError(`Se asignaron ${completed} pedidos. ${err(e)}`);break;}completed++;}
  if(completed===chosen.length)setNotice(`${completed} pedidos asignados a la ruta. Todavía no despachados.`);
  setChosen([]);await load();setBusy(false);
 }
 async function move(routeId:string,orderId:string,direction:number){if(!supabase||busy)return;
  const ordered=assignments.filter(a=>a.route_id===routeId).sort((a,b)=>a.stop_order-b.stop_order).map(a=>a.order_id);
  const i=ordered.indexOf(orderId),j=i+direction;if(i<0||j<0||j>=ordered.length)return;
  [ordered[i],ordered[j]]=[ordered[j],ordered[i]];setBusy(true);setError('');
  const {error:e}=await supabase.rpc('reorder_delivery_route',{p_route_id:routeId,p_order_ids:ordered});
  if(e)setError(err(e));await load();setBusy(false);
 }
 const available=orders.filter(o=>!assignments.some(a=>a.order_id===o.id));
 return <section className="delivery-module">
  <div className="delivery-heading"><div><h1>Reparto</h1><p>Organizá rutas y asigná pedidos listos.</p></div><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
  <p className="delivery-warning">Piloto: asignar una ruta NO despacha, descuenta inventario ni registra cobros.</p>
  {error&&<div className="delivery-error" role="alert">{error}<button onClick={()=>setError('')}>Cerrar</button></div>}
  {notice&&<div className="delivery-success" role="status">{notice}<button onClick={()=>setNotice('')}>Cerrar</button></div>}
  {staffRole!=='driver'&&<div className="delivery-grid"><section className="delivery-card"><h2>Crear ruta</h2>
   <label>Nombre de ruta<input value={label} maxLength={80} onChange={e=>setLabel(e.target.value)}/></label>
   <label>Repartidor<select value={driver} onChange={e=>setDriver(e.target.value)}><option value="">Seleccionar</option>{drivers.map(d=><option key={d.user_id} value={d.user_id}>{d.display_name}</option>)}</select></label>
   <button className="delivery-primary" disabled={busy||!driver||label.trim().length<2} onClick={()=>void create()}>Crear ruta</button>
   {!drivers.length&&<small>Para asignar repartidores, primero deben tener usuario activo con rol driver.</small>}
  </section><section className="delivery-card"><h2>Pedidos listos para asignar</h2>
   <label>Ruta de destino<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">Seleccionar ruta</option>{routes.map(r=><option key={r.id} value={r.id}>{r.label} · {drivers.find(d=>d.user_id===r.driver_id)?.display_name||'Repartidor'}</option>)}</select></label>
   {available.length===0?<p>No hay pedidos listos sin asignar.</p>:available.map(o=><label className="delivery-item" key={o.id}><input type="checkbox" checked={chosen.includes(o.id)} onChange={e=>setChosen(old=>e.target.checked?[...old,o.id]:old.filter(x=>x!==o.id))}/><span><strong>#{o.id.slice(0,8)}</strong> · {o.customer_name}<small>{money(o.total_cents)}</small></span></label>)}<button className="delivery-primary" disabled={busy||!selected||!chosen.length} onClick={()=>void assignSelected()}>Asignar {chosen.length} pedidos</button>
  </section></div>}
  {staffRole!=='driver'&&<section className="delivery-card"><h2>Rutas creadas</h2>{routes.length===0?<p>Todavía no hay rutas.</p>:routes.map(r=><div className="delivery-item" key={r.id}><span><strong>{r.label}</strong><small>{drivers.find(d=>d.user_id===r.driver_id)?.display_name||'Repartidor asignado'} · {assignments.filter(a=>a.route_id===r.id).length} pedidos asignados</small></span><div>{assignments.filter(a=>a.route_id===r.id).sort((a,b)=>a.stop_order-b.stop_order).map((a,i)=><div key={a.order_id} className="delivery-stop"><small>{i+1}. #{a.order_id.slice(0,8)}</small><button disabled={busy||i===0} onClick={()=>void move(r.id,a.order_id,-1)}>↑</button><button disabled={busy||i===assignments.filter(x=>x.route_id===r.id).length-1} onClick={()=>void move(r.id,a.order_id,1)}>↓</button></div>)}</div></div>)}</section>}
  {mine.length>0&&<section className="delivery-card"><h2>Mis entregas asignadas</h2>{mine.map(o=><div className="delivery-item" key={o.order_id}><span><strong>{o.stop_order}. {o.customer_name}</strong><small>{o.route_label} · {o.delivery_address}</small><small>{o.customer_phone} · {money(o.total_cents)}</small></span><a target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.delivery_address)}`}>Cómo llegar</a></div>)}</section>}
 </section>;
}
