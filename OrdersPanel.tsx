import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import './orders.css';

type Product = { id:string; name:string; unit:'lb'|'unit'|'package'; price_cents:number; stock:number };
type Order = {id:string;created_at:string;customer_name:string;customer_phone:string;delivery_address:string;notes:string;status:string;total_cents:number};
type Item = {variant_id:string;quantity:number};
type OrderLine = {order_id:string;variant_id:string;quantity:number;unit_price_cents:number;line_total_cents:number};
type Driver = {user_id:string;display_name:string};
type Assignment = {order_id:string;route_id:string};
type VariantLabel = {id:string;name:string;base_unit:string};
type PaymentEvent = {order_id:string;event_kind:'pending'|'payment';method:string;amount_cents:number;verified_at:string|null};
type PaymentMethod = 'cash'|'transfer_reported';
type TransferIssueEvent = {order_id:string;action:'reported'|'resolved';reason:string;created_at:string;event_seq:number};
const activeStatuses = ['received','accepted','preparing','ready','out_for_delivery'];
const cash=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const units:Record<Product['unit'],string>={lb:'lb',unit:'unidad',package:'paquete'};
const message=(error:unknown)=>{
  if (error && typeof error==='object' && 'message' in error) return String(error.message);
  return 'No se pudo completar la operación.';
};

export function OrdersPanel({staffRole='counter'}:{staffRole?:'admin'|'counter'|'driver'}){
  const [stage,setStage]=useState('all');
  const [search,setSearch]=useState('');
  const [view,setView]=useState<'customer'|'counter'>('counter');
  const [products,setProducts]=useState<Product[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [drivers,setDrivers]=useState<Driver[]>([]);
  const [assignments,setAssignments]=useState<Assignment[]>([]);
  const [chosen,setChosen]=useState<string[]>([]);
  const [driverId,setDriverId]=useState('');
  const [dispatchAttempt,setDispatchAttempt]=useState<{requestId:string;driverId:string;orderIds:string[]}|null>(null);
  const [orderLines,setOrderLines]=useState<OrderLine[]>([]);
  const [paymentEvents,setPaymentEvents]=useState<PaymentEvent[]>([]);
  const [transferIssues,setTransferIssues]=useState<TransferIssueEvent[]>([]);
  const [issueOrderId,setIssueOrderId]=useState<string|null>(null);
  const [issueAction,setIssueAction]=useState<'reported'|'resolved'>('reported');
  const [issueReason,setIssueReason]=useState('');
  const [payOrderId,setPayOrderId]=useState<string|null>(null);
  const [payMethod,setPayMethod]=useState<PaymentMethod>('cash');
  const [payTendered,setPayTendered]=useState('');
  const [paymentAttempt,setPaymentAttempt]=useState<{orderId:string;requestId:string;method:PaymentMethod;tenderedCents:number}|null>(null);
  const [variantLabels,setVariantLabels]=useState<Record<string,VariantLabel>>({});
  const [orderFilter,setOrderFilter]=useState<'active'|'history'>('active');
  const [items,setItems]=useState<Item[]>([]);
  const [name,setName]=useState('');const [phone,setPhone]=useState('');
  const [address,setAddress]=useState('');const [notes,setNotes]=useState('');
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
  const [requestId,setRequestId]=useState(()=>sessionStorage.getItem('im-order-pilot-request')||crypto.randomUUID());
  const selected=useMemo(()=>items.map(i=>({i,p:products.find(p=>p.id===i.variant_id)})).filter((x):x is {i:Item,p:Product}=>!!x.p),[items,products]);
  const total=selected.reduce((s,{i,p})=>s+Math.round(i.quantity*p.price_cents),0);
  const load=useCallback(async()=>{
    if(!supabase)return;
    const [variants,lots,orderResult,paymentResult]=await Promise.all([
      supabase.from('product_variants').select('id,name,base_unit,price_cents').eq('active',true),
      supabase.from('inventory_lots').select('variant_id,qty_on_hand,qty_reserved,status,use_by'),
      supabase.from('customer_orders').select('id,created_at,customer_name,customer_phone,delivery_address,notes,status,total_cents').order('created_at',{ascending:false}).limit(60),
      supabase.from('delivery_payment_events').select('order_id,event_kind,method,amount_cents,verified_at')
    ]);
    const failure=variants.error||lots.error||orderResult.error||paymentResult.error;
    if(failure){setError(message(failure));return;}
    const today=new Date().toISOString().slice(0,10);
    const stock=new Map<string,number>();
    for(const lot of lots.data||[]){
      if(lot.status!=='available'||(lot.use_by&&lot.use_by<today))continue;
      stock.set(lot.variant_id,(stock.get(lot.variant_id)||0)+Number(lot.qty_on_hand)-Number(lot.qty_reserved));
    }
    setProducts((variants.data||[]).map(v=>({id:v.id,name:v.name,unit:v.base_unit as Product['unit'],price_cents:v.price_cents,stock:Math.max(0,stock.get(v.id)||0)})));
    const fetchedOrders=(orderResult.data||[]) as Order[];
    if(fetchedOrders.length){
      const lineResult=await supabase.from('customer_order_lines')
        .select('order_id,variant_id,quantity,unit_price_cents,line_total_cents')
        .in('order_id',fetchedOrders.map(o=>o.id));
      if(lineResult.error){setError('No se pudo cargar el detalle de los pedidos: '+message(lineResult.error));return;}
      const lines=(lineResult.data||[]) as OrderLine[];
      const variantIds=[...new Set(lines.map(l=>l.variant_id))];
      let labels:VariantLabel[]=[];
      if(variantIds.length){
        const labelResult=await supabase.from('product_variants')
          .select('id,name,base_unit').in('id',variantIds);
        if(labelResult.error){setError('No se pudieron cargar los nombres de los productos: '+message(labelResult.error));return;}
        labels=(labelResult.data||[]) as VariantLabel[];
      }
      setOrderLines(lines);
      setVariantLabels(Object.fromEntries(labels.map(v=>[v.id,v])));
    }else{setOrderLines([]);setVariantLabels({});}
    if(staffRole==='admin'){
      const issues=await supabase.from('delivery_transfer_issue_events').select('order_id,action,reason,created_at,event_seq').order('event_seq',{ascending:false}).limit(1000);
      if(issues.error){setError('No se pudieron consultar las incidencias: '+message(issues.error));return;}
      setTransferIssues((issues.data||[]) as TransferIssueEvent[]);
    }
    if(staffRole!=='driver'){
      const [driverResult,assignmentResult]=await Promise.all([
        supabase.from('staff_profiles').select('user_id,display_name').in('role',['driver','admin']).eq('active',true),
        supabase.from('delivery_assignments').select('order_id,route_id').limit(1000)
      ]);
      if(driverResult.error||assignmentResult.error){setError('No se pudieron consultar las asignaciones: '+message(driverResult.error||assignmentResult.error));return;}
      setDrivers((driverResult.data||[]) as Driver[]);
      setAssignments((assignmentResult.data||[]) as Assignment[]);
    }
    setOrders(fetchedOrders);setPaymentEvents((paymentResult.data||[]) as PaymentEvent[]);setError('');
  },[staffRole]);
  useEffect(()=>{
    void load();
    // Keep the counter view current when delivery staff change order statuses.
    // Polling works without requiring changes to the Supabase Realtime publication.
    const refresh=()=>{if(document.visibilityState==='visible')void load();};
    window.addEventListener('focus',refresh);
    document.addEventListener('visibilitychange',refresh);
    const timer=window.setInterval(refresh,15000);
    return()=>{
      window.removeEventListener('focus',refresh);
      document.removeEventListener('visibilitychange',refresh);
      window.clearInterval(timer);
    };
  },[load]);
  function adjust(p:Product,delta:number){
    setItems(old=>{
      const current=old.find(x=>x.variant_id===p.id)?.quantity||0;
      const next=Math.round((current+delta)*10000)/10000;
      if(delta>0&&next>p.stock){setError('No hay suficientes existencias para agregar más.');return old;}
      return next<=0?old.filter(x=>x.variant_id!==p.id):old.some(x=>x.variant_id===p.id)?old.map(x=>x.variant_id===p.id?{...x,quantity:next}:x):[...old,{variant_id:p.id,quantity:next}];
    });
  }
  async function submit(e:React.FormEvent){
    e.preventDefault();if(!supabase||busy||!items.length)return;
    setBusy(true);setError('');setNotice('');
    sessionStorage.setItem('im-order-pilot-request',requestId);
    try{
      const {data,error:failure}=await supabase.rpc('submit_pilot_order',{
        p_request_id:requestId,p_customer_name:name,p_customer_phone:phone,
        p_delivery_address:address,p_notes:notes,p_items:items
      });
      if(failure)throw failure;
      setNotice(`Pedido recibido: ${String(data).slice(0,8)}. Pendiente de aceptación.`);
      setItems([]);setName('');setPhone('');setAddress('');setNotes('');
      const next=crypto.randomUUID();setRequestId(next);sessionStorage.removeItem('im-order-pilot-request');
      await load();
    }catch(e){setError(message(e)+' Si no estás seguro del resultado, no envíes otra vez con un ID diferente.');}
    finally{setBusy(false);}
  }
  async function act(id:string,action:'accept'|'cancel'|'prepare'|'ready'){
    if(!supabase||busy)return;
    setBusy(true);setError('');setNotice('');
    const rpc = action==='accept'?'accept_and_prepare_pilot_order':action==='cancel'?'cancel_order_and_cleanup':'advance_pilot_order';
    const args = action==='prepare'?{p_order_id:id,p_expected_status:'accepted',p_new_status:'preparing'}:action==='ready'?{p_order_id:id,p_expected_status:'preparing',p_new_status:'ready'}:{p_order_id:id};
    const {error:failure}=await supabase.rpc(rpc,args);
    if(failure)setError(message(failure));else setNotice(action==='accept'?'Pedido aceptado y en preparación. Inventario reservado.':action==='cancel'?'Pedido cancelado. Reservas liberadas.':action==='prepare'?'Pedido en preparación.':'Pedido listo para entregar.');
    await load();setBusy(false);
  }
  const readyToDispatch=orders.filter(o=>o.status==='ready'&&!assignments.some(a=>a.order_id===o.id));
  const selectedForDispatch=chosen.filter(id=>readyToDispatch.some(o=>o.id===id));
  async function sendToDelivery(){
    if(!supabase||busy||!driverId||!selectedForDispatch.length)return;
    const ids=[...selectedForDispatch].sort();
    if(dispatchAttempt&&(dispatchAttempt.driverId!==driverId||JSON.stringify(dispatchAttempt.orderIds)!==JSON.stringify(ids))){
      setError('Hay un envío anterior por verificar. No cambiés los pedidos ni el repartidor antes de resolverlo.');return;
    }
    const attempt=dispatchAttempt||{requestId:crypto.randomUUID(),driverId,orderIds:ids};
    setDispatchAttempt(attempt);setBusy(true);setError('');setNotice('');
    try{
      const {data,error:failure}=await supabase.rpc('prepare_and_dispatch_outing',{
        p_request_id:attempt.requestId,p_driver_id:attempt.driverId,p_order_ids:attempt.orderIds
      });
      if(failure)throw failure;
      setDispatchAttempt(null);setChosen([]);
      setNotice(`Salida confirmada (${String(data).slice(0,8)}). ${ids.length} pedidos enviados a reparto.`);
      await load();
    }catch(e){setError(message(e)+' Si el resultado es incierto, revisá Reparto antes de reintentar. Se conserva el identificador de solicitud.');}
    finally{setBusy(false);}
  }
  const paymentFor=(id:string)=>paymentEvents.find(e=>e.order_id===id&&e.event_kind==='payment');
  const issueFor=(id:string)=>transferIssues.find(e=>e.order_id===id);
  function openIssue(id:string,action:'reported'|'resolved'){
    setIssueOrderId(id);setIssueAction(action);setIssueReason('');setError('');
  }
  async function saveIssue(){
    if(!supabase||busy||!issueOrderId||issueReason.trim().length<3)return;
    setBusy(true);setError('');setNotice('');
    const {error:failure}=await supabase.rpc('set_delivery_transfer_issue',{
      p_order_id:issueOrderId,p_action:issueAction,p_reason:issueReason.trim()
    });
    if(failure){setError(message(failure));}
    else {setIssueOrderId(null);setIssueReason('');setNotice(issueAction==='reported'?'Problema registrado. La entrega no cambió.':'Incidencia resuelta.');await load();}
    setBusy(false);
  }
  const pendingFor=(id:string)=>paymentEvents.some(e=>e.order_id===id&&e.event_kind==='pending');
  function paymentLabel(id:string){
    const payment=paymentFor(id);
    if(payment?.method==='cash')return 'Cobrado en efectivo';
    if(payment?.method==='transfer_reported')return issueFor(id)?.action==='reported'?'Transferencia con problema':payment.verified_at?'Transferencia verificada':'Transferencia reportada';
    if(pendingFor(id))return 'Pago pendiente';
    return 'Sin registro de cobro';
  }
  function openPayment(id:string){
    if(busy||paymentAttempt)return;
    setPayOrderId(id);setPayMethod('cash');setPayTendered('');setError('');
  }
  async function collectPayment(){
    if(!supabase||busy||!payOrderId)return;
    const order=orders.find(o=>o.id===payOrderId);
    if(!order||order.status!=='delivered'||!pendingFor(order.id)||paymentFor(order.id)){
      setError('Este pedido ya no tiene un cobro pendiente disponible. Actualizá los pedidos.');return;
    }
    const value=Number(payTendered);
    const tenderedCents=payMethod==='cash'?Math.round(value*100):0;
    if(payMethod==='cash'&&(!payTendered.trim()||!Number.isFinite(value)||!Number.isSafeInteger(tenderedCents)||tenderedCents<order.total_cents)){
      setError('Ingresá efectivo suficiente para cubrir el total del pedido.');return;
    }
    if(paymentAttempt&&(paymentAttempt.orderId!==order.id||paymentAttempt.method!==payMethod||paymentAttempt.tenderedCents!==tenderedCents)){
      setError('Existe un cobro con resultado incierto. Verificá el registro antes de cambiar los datos.');return;
    }
    const attempt=paymentAttempt||{orderId:order.id,requestId:crypto.randomUUID(),method:payMethod,tenderedCents};
    setPaymentAttempt(attempt);setBusy(true);setError('');setNotice('');
    try{
      const {error:failure}=await supabase.rpc('confirm_delivery_with_payment',{
        p_order_id:attempt.orderId,p_request_id:attempt.requestId,p_method:attempt.method,p_cash_tendered_cents:attempt.tenderedCents
      });
      if(failure){setError(message(failure)+' Verificá Supabase antes de volver a intentar.');return;}
      setPaymentAttempt(null);setPayOrderId(null);setPayTendered('');
      setNotice('Cobro posterior registrado. El pedido continúa entregado.');
      await load();
    }catch(e){setError(message(e)+' Resultado incierto: verificá antes de reintentar.');}
    finally{setBusy(false);}
  }
  const activeOrders=orders.filter(o=>activeStatuses.includes(o.status)).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const historyOrders=orders.filter(o=>!activeStatuses.includes(o.status));
  const visibleOrders=(orderFilter==='active'?activeOrders:historyOrders).filter(o=>(orderFilter==='history'||stage==='all'||(stage==='preparing'?['accepted','preparing'].includes(o.status):o.status===stage))&&`${o.customer_name} ${o.customer_phone} ${o.id} ${o.delivery_address}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="orders-module">
    <div className="op-main"><div className="op-head"><div><h1>Pedidos</h1><p>Del pedido recibido a la entrega.</p></div><button className="op-outline" onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
      <div className="op-tabs" aria-label="Vistas de pedidos"><button className={view==='counter'&&orderFilter==='active'?'on':''} onClick={()=>{setView('counter');setOrderFilter('active')}}>Activos ({activeOrders.length})</button><button className={view==='counter'&&orderFilter==='history'?'on':''} onClick={()=>{setView('counter');setOrderFilter('history')}}>Historial</button><button className={view==='customer'?'on':''} onClick={()=>setView('customer')}>Nuevo pedido</button></div>
      <details className="feature-note"><summary>Pedidos internos de prueba</summary><p>La tienda pública para clientes todavía no está habilitada.</p></details>
      {error&&<div className="op-error" role="alert">{error}<button onClick={()=>setError('')}>Cerrar</button></div>}
      {notice&&<div className="op-success" role="status">{notice}<button onClick={()=>setNotice('')}>Cerrar</button></div>}
      {view==='customer'?<div className="op-columns"><section><h2>Productos</h2><div className="op-products">{products.map(p=>{
        const qty=items.find(x=>x.variant_id===p.id)?.quantity||0;const increment=p.unit==='lb'?0.5:1;
        return <div className="op-product" key={p.id}><div><strong>{p.name}</strong><small>{cash(p.price_cents)} / {units[p.unit]} · {p.stock} disponibles</small></div><div className="op-qty"><button aria-label={'Quitar '+p.name} onClick={()=>adjust(p,-increment)} disabled={busy||qty===0}>−</button><span>{qty}</span><button aria-label={'Agregar '+p.name} onClick={()=>adjust(p,increment)} disabled={busy||qty+increment>p.stock}>+</button></div></div>;
      })}</div></section><form className="op-form" onSubmit={e=>void submit(e)}><h2>Datos del pedido</h2><label>Nombre<input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={120} required/></label><label>Teléfono<input value={phone} onChange={e=>setPhone(e.target.value)} minLength={8} maxLength={22} required/></label><label>Dirección de entrega<textarea value={address} onChange={e=>setAddress(e.target.value)} minLength={5} maxLength={300} required rows={2}/></label><label>Indicaciones (opcional)<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500} rows={2}/></label><div className="op-total"><span>Total estimado</span><strong>{cash(total)}</strong></div><button className="op-primary" disabled={busy||items.length===0}>{busy?'Enviando…':'Crear pedido de prueba'}</button><small>El inventario se reserva únicamente cuando mostrador acepta el pedido.</small></form></div>
      :<><div className="order-work-toolbar"><label className="module-search"><span className="sr-only">Buscar pedidos</span><input type="search" placeholder="Buscar cliente, teléfono o pedido" value={search} onChange={e=>setSearch(e.target.value)}/></label></div>{orderFilter==='active'&&<div className="order-stages" aria-label="Etapas del pedido">{([['all','Todos'],['received','Recibidos'],['preparing','En preparación'],['ready','Listos'],['out_for_delivery','En reparto']] as const).map(([id,label])=><button key={id} aria-pressed={stage===id} onClick={()=>setStage(id)}>{label}<span>{id==='all'?activeOrders.length:activeOrders.filter(o=>id==='preparing'?['accepted','preparing'].includes(o.status):o.status===id).length}</span></button>)}</div>}{orderFilter==='active'&&staffRole!=='driver'&&readyToDispatch.length>0&&<details className="work-disclosure order-dispatch-disclosure"><summary><strong>Enviar pedidos a reparto</strong><span>{selectedForDispatch.length?`${selectedForDispatch.length} seleccionados`: `${readyToDispatch.length} listos`} →</span></summary><section className="op-dispatch-box" aria-label="Enviar pedidos listos a reparto">
        <div><strong>Enviar pedidos a reparto</strong><p>Seleccioná los pedidos listos y elegí quién los lleva. Al confirmar, salen del local.</p></div>
        <div className="op-dispatch-options">
          <label>Repartidor<select value={driverId} disabled={busy||!!dispatchAttempt} onChange={e=>setDriverId(e.target.value)}><option value="">Elegí repartidor</option>{drivers.map(d=><option key={d.user_id} value={d.user_id}>{d.display_name}</option>)}</select></label>
          <div className="op-dispatch-actions"><span>{selectedForDispatch.length} seleccionados</span><button className="op-primary" type="button" disabled={busy||!driverId||!selectedForDispatch.length} onClick={()=>void sendToDelivery()}>{busy?'Enviando…':`Enviar ${selectedForDispatch.length} a reparto`}</button></div>
        </div>
        {dispatchAttempt&&<small className="op-dispatch-note">Si el envío anterior falló o quedó incierto, verificá Reparto antes de volver a intentar. No cambiés la selección.</small>}
      </section></details>}<section className="op-orders">{visibleOrders.length===0?<p className="op-empty">{search.trim()||orderFilter==='active'&&stage!=='all'?'No hay pedidos con estos filtros.':orderFilter==='active'?'No hay pedidos pendientes.':'No hay pedidos en el historial reciente.'}</p>:visibleOrders.map(o=><article className="op-order" key={o.id}><div className="op-orderhead"><strong>{orderFilter==='active'&&staffRole!=='driver'&&o.status==='ready'&&!assignments.some(a=>a.order_id===o.id)&&<label className="op-dispatch-check"><input type="checkbox" aria-label={`Seleccionar pedido ${o.id.slice(0,8)}`} checked={selectedForDispatch.includes(o.id)} disabled={busy||!!dispatchAttempt} onChange={e=>setChosen(prev=>e.target.checked?[...prev,o.id]:prev.filter(id=>id!==o.id))}/></label>}#{o.id.slice(0,8)} · {o.customer_name}</strong><span>{({received:'Recibido',accepted:'Aceptado',preparing:'En preparación',ready:'Listo',out_for_delivery:'En reparto',delivered:'Entregado',cancelled:'Cancelado'} as Record<string,string>)[o.status]||o.status}</span></div><p>{o.customer_phone} · {o.delivery_address}</p>
        <details className="op-order-detail" open={orderFilter==='active'}><summary>Productos del pedido</summary><div className="op-order-items">
          {orderLines.filter(l=>l.order_id===o.id).length===0
            ? <p className="op-item-missing">No se encontró el detalle de este pedido. Verificá antes de prepararlo.</p>
            : orderLines.filter(l=>l.order_id===o.id).map(l=>{
                const variant=variantLabels[l.variant_id];
                const unit=variant?.base_unit==='lb'?'lb':variant?.base_unit==='package'?'paquete':'unidad';
                return <div className="op-order-item" key={l.variant_id}>
                  <span><b>{variant?.name||'Producto no disponible en catálogo'}</b><small>{Number(l.quantity)} {unit} × {cash(Number(l.unit_price_cents))}</small></span>
                  <strong>{cash(Number(l.line_total_cents))}</strong>
                </div>;
              })}
        </div></details>
        {o.notes&&<p className="op-notes"><strong>Indicaciones:</strong> {o.notes}</p>}<div className="op-orderfoot"><strong>{cash(Number(o.total_cents))}</strong><small>{new Date(o.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></div><div className="op-actions">
        {o.status==='received'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'accept')}>Aceptar pedido</button>}
        {o.status==='accepted'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'prepare')}>Continuar preparación (pedido anterior)</button>}
        {o.status==='preparing'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'ready')}>Marcar listo</button>}
        {['received','accepted','preparing','ready'].includes(o.status)&&<button className="op-outline" disabled={busy} onClick={()=>{if(window.confirm('¿Cancelar este pedido? Se liberarán las reservas.'))void act(o.id,'cancel');}}>Cancelar pedido</button>}
        {o.status==='delivered'&&<div className="op-payment-status"><span>Estado del pago</span><strong>{paymentLabel(o.id)}</strong>{pendingFor(o.id)&&!paymentFor(o.id)&&<span>Saldo por cobrar: {cash(Number(o.total_cents))}</span>}</div>}
        {staffRole==='admin'&&o.status==='delivered'&&paymentFor(o.id)?.method==='transfer_reported'&&!paymentFor(o.id)?.verified_at&&(
          issueFor(o.id)?.action==='reported'
          ? <button type="button" className="op-outline" disabled={busy} onClick={()=>openIssue(o.id,'resolved')}>Resolver problema</button>
          : <button type="button" className="op-outline" disabled={busy} onClick={()=>openIssue(o.id,'reported')}>Reportar problema</button>
        )}
        {o.status==='delivered'&&pendingFor(o.id)&&!paymentFor(o.id)&&<button type="button" className="op-primary" disabled={busy||!!paymentAttempt} onClick={()=>openPayment(o.id)}>Registrar cobro</button>}
        {o.status==='ready'&&<small>{assignments.some(a=>a.order_id===o.id)?'Ya asignado a una ruta. Revisá Reparto.':'Seleccioná este pedido arriba para enviarlo a reparto.'}</small>}
      </div></article>)}</section></>}
    </div>
    {issueOrderId&&staffRole==='admin'&&<div className="op-payment-backdrop"><div className="op-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="op-issue-title">
      <h2 id="op-issue-title">{issueAction==='reported'?'Reportar problema de transferencia':'Resolver problema de transferencia'}</h2>
      <p>Pedido #{issueOrderId.slice(0,8)}. El pedido seguirá entregado y el pago original se conservará.</p>
      <label className="op-issue-label" htmlFor="op-issue-reason">{issueAction==='reported'?'¿Qué ocurrió?':'¿Cómo se resolvió?'}</label>
      <textarea id="op-issue-reason" rows={3} maxLength={500} value={issueReason} disabled={busy} onChange={e=>setIssueReason(e.target.value)} placeholder={issueAction==='reported'?'Ej. No aparece el depósito en la cuenta':'Ej. Cliente envió datos correctos y se aclaró el pago'}/>
      <div className="op-payment-actions"><button type="button" className="op-outline" disabled={busy} onClick={()=>setIssueOrderId(null)}>Volver</button><button type="button" className="op-primary" disabled={busy||issueReason.trim().length<3} onClick={()=>void saveIssue()}>{busy?'Guardando…':issueAction==='reported'?'Reportar problema':'Resolver problema'}</button></div>
    </div></div>}
    {payOrderId&&(()=>{
      const order=orders.find(o=>o.id===payOrderId);
      if(!order)return null;
      const amount=Number(payTendered);
      const cents=Number.isFinite(amount)?Math.round(amount*100):0;
      const validCash=payTendered.trim()!==''&&Number.isFinite(amount)&&Number.isSafeInteger(cents)&&cents>=Number(order.total_cents);
      return <div className="op-payment-backdrop"><div className="op-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="op-payment-title">
        <h2 id="op-payment-title">Registrar cobro pendiente</h2>
        <p>Pedido #{order.id.slice(0,8)} · {order.customer_name}</p>
        <div className="op-payment-total"><span>Saldo por cobrar</span><strong>{cash(Number(order.total_cents))}</strong></div>
        <fieldset><legend>¿Cómo pagó el cliente?</legend>
          <label><input type="radio" checked={payMethod==='cash'} disabled={busy||!!paymentAttempt} onChange={()=>setPayMethod('cash')}/> Efectivo</label>
          <label><input type="radio" checked={payMethod==='transfer_reported'} disabled={busy||!!paymentAttempt} onChange={()=>setPayMethod('transfer_reported')}/> Transferencia reportada</label>
        </fieldset>
        {payMethod==='cash'?<div className="op-payment-cash"><label htmlFor="op-payment-tendered">Efectivo recibido (Q)</label><input id="op-payment-tendered" type="number" inputMode="decimal" step="0.01" min="0" value={payTendered} disabled={busy||!!paymentAttempt} onChange={e=>setPayTendered(e.target.value)} placeholder="Ej. 50.00"/><div className="op-payment-total"><span>Cambio a devolver</span><strong>{validCash?cash(cents-Number(order.total_cents)):'—'}</strong></div></div>:<p>La transferencia quedará reportada hasta que el administrador la verifique en el banco.</p>}
        {paymentAttempt&&<p className="op-payment-warning">Hay una solicitud pendiente de verificar. No cambies los datos ni generés otro intento.</p>}
        <div className="op-payment-actions"><button type="button" className="op-outline" disabled={busy||!!paymentAttempt} onClick={()=>setPayOrderId(null)}>Volver</button><button type="button" className="op-primary" disabled={busy||!!paymentAttempt||(payMethod==='cash'&&!validCash)} onClick={()=>void collectPayment()}>{busy?'Registrando…':'Confirmar cobro'}</button></div>
      </div></div>;
    })()}
  </div>;
}

