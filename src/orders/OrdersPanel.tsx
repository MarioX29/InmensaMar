import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import './orders.css';
import {OrderDeliveryInfo,useDeliveryPreferences} from './OrderDeliveryInfo';
import {unitLabels,quantityStep} from '../lib/units';
import type {InventoryUnit} from '../lib/units';
import { QuantityInput } from '../components/QuantityInput';

type Product = { id:string; name:string; unit:InventoryUnit; price_cents:number; stock:number };
type Order = {id:string;created_at:string;customer_name:string;customer_phone:string;delivery_address:string;notes:string;status:string;total_cents:number};
type Item = {variant_id:string;quantity:number};
type OrderLine = {id:string;order_id:string;variant_id:string;quantity:number;unit_price_cents:number;line_total_cents:number};
type VariantLabel = {id:string;name:string;base_unit:string};
type PaymentEvent = {order_id:string;event_kind:'pending'|'payment';method:string;amount_cents:number;verified_at:string|null};
type PaymentMethod = 'cash'|'transfer_reported';
type TransferIssueEvent = {order_id:string;action:'reported'|'resolved';reason:string;created_at:string;event_seq:number};
const activeStatuses = ['received','accepted','preparing','ready','out_for_delivery','return_pending'];
const cash=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const units=unitLabels;
const message=(error:unknown)=>{
  if (error && typeof error==='object' && 'message' in error) return String(error.message);
  return 'No se pudo completar la operación.';
};

export function OrdersPanel({staffRole='counter'}:{staffRole?:'admin'|'counter'|'driver'}){
  const [stage,setStage]=useState<'local'|'delivery'>('local');
  const [search,setSearch]=useState('');
  const [view,setView]=useState<'customer'|'counter'>('counter');
  const [products,setProducts]=useState<Product[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const deliveryInfo=useDeliveryPreferences(orders.map(o=>o.id));
  const [orderLines,setOrderLines]=useState<OrderLine[]>([]);
  const [paymentEvents,setPaymentEvents]=useState<PaymentEvent[]>([]);
  const [transferIssues,setTransferIssues]=useState<TransferIssueEvent[]>([]);
  const [issueOrderId,setIssueOrderId]=useState<string|null>(null);
  const [priceEditor,setPriceEditor]=useState<{order:Order;line:OrderLine}|null>(null);
  const [priceDraft,setPriceDraft]=useState('');
  const [priceReason,setPriceReason]=useState('');
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
    const [variants,lots,orderResult,historyResult,paymentResult]=await Promise.all([
      supabase.from('product_variants').select('id,name,base_unit,price_cents').eq('active',true),
      supabase.from('inventory_lots').select('variant_id,qty_on_hand,qty_reserved,status,use_by'),
      supabase.from('customer_orders').select('id,created_at,customer_name,customer_phone,delivery_address,notes,status,total_cents').in('status',activeStatuses).order('created_at',{ascending:true}),
      supabase.from('customer_orders').select('id,created_at,customer_name,customer_phone,delivery_address,notes,status,total_cents').in('status',['delivered','cancelled']).order('created_at',{ascending:false}).limit(60),
      supabase.from('delivery_payment_events').select('order_id,event_kind,method,amount_cents,verified_at')
    ]);
    const failure=variants.error||lots.error||orderResult.error||historyResult.error||paymentResult.error;
    if(failure){setError(message(failure));return;}
    const today=new Date().toISOString().slice(0,10);
    const stock=new Map<string,number>();
    for(const lot of lots.data||[]){
      if(lot.status!=='available'||(lot.use_by&&lot.use_by<today))continue;
      stock.set(lot.variant_id,(stock.get(lot.variant_id)||0)+Number(lot.qty_on_hand)-Number(lot.qty_reserved));
    }
    setProducts((variants.data||[]).map(v=>({id:v.id,name:v.name,unit:v.base_unit as Product['unit'],price_cents:v.price_cents,stock:Math.max(0,stock.get(v.id)||0)})));
    const fetchedOrders=[...new Map([...(historyResult.data||[]),...(orderResult.data||[])].map(o=>[o.id,o])).values()] as Order[];
    if(fetchedOrders.length){
      const lineResult=await supabase.from('customer_order_lines')
        .select('id,order_id,variant_id,quantity,unit_price_cents,line_total_cents')
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
  useEffect(()=>{
    const menuSelector='details.order-more-options, details.order-line-more';
    const closeOtherMenus=(event:PointerEvent)=>{
      const target=event.target;
      const clickedMenu=target instanceof Element?target.closest<HTMLDetailsElement>(menuSelector):null;
      document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`).forEach(menu=>{
        if(menu!==clickedMenu)menu.open=false;
      });
    };
    const closeMenusOnEscape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape')return;
      const openMenus=[...document.querySelectorAll<HTMLDetailsElement>(`${menuSelector}[open]`)];
      openMenus.forEach(menu=>{menu.open=false;});
      openMenus[0]?.querySelector<HTMLElement>('summary')?.focus();
    };
    const closeSelectedMenu=(event:MouseEvent)=>{
      const target=event.target;
      const action=target instanceof Element?target.closest('details.order-more-options button, details.order-line-more button'):null;
      action?.closest<HTMLDetailsElement>('details')?.removeAttribute('open');
    };
    document.addEventListener('pointerdown',closeOtherMenus);
    document.addEventListener('keydown',closeMenusOnEscape);
    document.addEventListener('click',closeSelectedMenu);
    return()=>{
      document.removeEventListener('pointerdown',closeOtherMenus);
      document.removeEventListener('keydown',closeMenusOnEscape);
      document.removeEventListener('click',closeSelectedMenu);
    };
  },[]);
  function adjust(p:Product,delta:number){
    setItems(old=>{
      const current=old.find(x=>x.variant_id===p.id)?.quantity||0;
      const next=Math.round((current+delta)*10000)/10000;
      if(delta>0&&next>p.stock){setError('No hay suficientes existencias para agregar más.');return old;}
      return next<=0?old.filter(x=>x.variant_id!==p.id):old.some(x=>x.variant_id===p.id)?old.map(x=>x.variant_id===p.id?{...x,quantity:next}:x):[...old,{variant_id:p.id,quantity:next}];
    });
  }
  function setOrderItemQuantity(p:Product,quantity:number){
    const next=Math.round(quantity*10000)/10000;
    if(!Number.isFinite(next)||next<=0||next>p.stock||(p.unit!=='lb'&&!Number.isInteger(next))){setError('La cantidad debe ser válida y no superar el inventario disponible.');return;}
    setItems(old=>old.some(item=>item.variant_id===p.id)?old.map(item=>item.variant_id===p.id?{...item,quantity:next}:item):[...old,{variant_id:p.id,quantity:next}]);
    setError('');
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
  const paymentFor=(id:string)=>paymentEvents.find(e=>e.order_id===id&&e.event_kind==='payment');
  const issueFor=(id:string)=>transferIssues.find(e=>e.order_id===id);
  function openIssue(id:string,action:'reported'|'resolved'){
    setIssueOrderId(id);setIssueAction(action);setIssueReason('');setError('');
  }
  function openPriceEditor(order:Order,line:OrderLine){
    setPriceEditor({order,line});
    setPriceDraft((Number(line.unit_price_cents)/100).toFixed(2));
    setPriceReason('');
    setError('');
  }
  async function saveOrderLinePrice(){
    if(!supabase||busy||staffRole!=='admin'||!priceEditor)return;
    const amount=Number(priceDraft);
    const cents=Math.round(amount*100);
    if(!Number.isFinite(amount)||!Number.isSafeInteger(cents)||cents<0||cents>100000000){setError('Ingresá un precio válido.');return;}
    if(priceReason.trim().length<3){setError('Indicá el acuerdo o motivo del cambio.');return;}
    setBusy(true);setError('');setNotice('');
    const {error:failure}=await supabase.rpc('admin_adjust_order_line_price',{
      p_request_id:crypto.randomUUID(),
      p_order_line_id:priceEditor.line.id,
      p_new_unit_price_cents:cents,
      p_reason:priceReason.trim()
    });
    if(failure){setError(message(failure));}
    else{
      setNotice('Precio actualizado para este pedido. El catálogo no fue modificado.');
      setPriceEditor(null);setPriceDraft('');setPriceReason('');
      await load();
    }
    setBusy(false);
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
  const activeOrders=orders.filter(o=>activeStatuses.includes(o.status)).sort((a,b)=>{const priority=(status:string)=>status==='received'?0:['accepted','preparing'].includes(status)?1:status==='ready'?2:3;return priority(a.status)-priority(b.status)||a.created_at.localeCompare(b.created_at)});
  const historyOrders=orders.filter(o=>!activeStatuses.includes(o.status));
  const stageMatches=(o:Order,id:typeof stage)=>id==='local'?['received','accepted','preparing','ready'].includes(o.status):['out_for_delivery','return_pending'].includes(o.status);
  const visibleOrders=(orderFilter==='active'?activeOrders:historyOrders).filter(o=>(orderFilter==='history'||stageMatches(o,stage))&&`${o.customer_name} ${o.customer_phone} ${o.id} ${o.delivery_address}`.toLowerCase().includes(search.trim().toLowerCase()));
  return <div className="orders-module">
    <div className="op-main"><div className="op-head"><div><h1>Pedidos</h1><p>Recibí, prepará y dejá listo para el repartidor.</p></div><button className="op-outline" onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
      <div className="op-tabs" aria-label="Vistas de pedidos">{([['local','En tienda'],['delivery','En reparto']] as const).map(([id,label])=><button key={id} className={view==='counter'&&orderFilter==='active'&&stage===id?'on':''} onClick={()=>{setView('counter');setOrderFilter('active');setStage(id)}}>{label} ({activeOrders.filter(o=>stageMatches(o,id)).length})</button>)}<button className={view==='counter'&&orderFilter==='history'?'on':''} onClick={()=>{setView('counter');setOrderFilter('history')}}>Historial</button><button className={view==='customer'?'on':''} onClick={()=>setView('customer')}>Nuevo pedido</button></div>

      {deliveryInfo.failed&&<p role="alert" className="op-payment-warning">No pudimos cargar ubicación y preferencias de pago. <button type="button" onClick={deliveryInfo.retry}>Reintentar datos de entrega</button></p>}{error&&<div className="op-error" role="alert">{error}<button onClick={()=>setError('')}>Cerrar</button></div>}
      {notice&&<div className="op-success" role="status">{notice}<button onClick={()=>setNotice('')}>Cerrar</button></div>}
      {view==='customer'?<div className="op-columns"><section><h2>Productos</h2><div className="op-products">{products.map(p=>{
        const qty=items.find(x=>x.variant_id===p.id)?.quantity||0;const increment=quantityStep(p.unit);
        return <div className="op-product" key={p.id}><div><strong>{p.name}</strong><small>{cash(p.price_cents)} / {units[p.unit]} · {p.stock} disponibles</small></div><div className="op-qty"><button aria-label={'Quitar '+p.name} onClick={()=>adjust(p,-increment)} disabled={busy||qty===0}>−</button><span>{qty}</span><button aria-label={'Agregar '+p.name} onClick={()=>adjust(p,increment)} disabled={busy||qty+increment>p.stock}>+</button></div></div>;
      })}</div></section><form className="op-form" onSubmit={e=>void submit(e)}><h2>Datos del pedido</h2><label>Nombre<input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={120} required/></label><label>Teléfono<input value={phone} onChange={e=>setPhone(e.target.value)} minLength={8} maxLength={22} required/></label><label>Dirección de entrega<textarea value={address} onChange={e=>setAddress(e.target.value)} minLength={5} maxLength={300} required rows={2}/></label><label>Indicaciones (opcional)<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500} rows={2}/></label>{selected.length>0&&<div className="op-selected-quantities"><h3>Cantidades del pedido</h3>{selected.map(({i,p})=><div className="op-selected-quantity" key={p.id}><strong>{p.name}</strong><QuantityInput unit={p.unit} value={i.quantity} disabled={busy} label="Cantidad" onCommit={value=>setOrderItemQuantity(p,value)}/><button type="button" className="op-remove-line" aria-label={`Eliminar ${p.name} del pedido`} title="Eliminar producto" disabled={busy} onClick={()=>setItems(old=>old.filter(item=>item.variant_id!==p.id))}>×</button></div>)}</div>}<div className="op-total"><span>Total estimado</span><strong>{cash(total)}</strong></div><button className="op-primary" disabled={busy||items.length===0}>{busy?'Enviando…':'Crear pedido'}</button><small>El inventario se reserva únicamente cuando mostrador acepta el pedido.</small></form></div>
      :<><div className="order-work-toolbar"><label className="module-search"><span className="sr-only">Buscar pedidos</span><input type="search" placeholder="Buscar cliente, teléfono o pedido" value={search} onChange={e=>setSearch(e.target.value)}/></label></div><section className="op-orders">{visibleOrders.length===0?<p className="op-empty">{search.trim()?'No hay pedidos con esta búsqueda.':orderFilter==='history'?'No hay pedidos en el historial reciente.':stage==='local'?'No hay pedidos en tienda.':'No hay pedidos en reparto.'}</p>:visibleOrders.map((o,i)=>{
        const linesForOrder=orderLines.filter(line=>line.order_id===o.id);
        const deliveryDetails=deliveryInfo.rows[o.id];
        const hasDeliveryDetails=Boolean(deliveryDetails?.delivery_preferences||o.notes);
        const statusLabel=({received:'Recibido',accepted:'Aceptado',preparing:'En preparación',ready:'Listo',out_for_delivery:'En reparto',delivered:'Entregado',cancelled:'Cancelado',return_pending:'Regreso al local'} as Record<string,string>)[o.status]||o.status;
        return <Fragment key={o.id}>{orderFilter==='active'&&stage==='local'&&(i===0||(visibleOrders[i-1].status==='received'?'received':['accepted','preparing'].includes(visibleOrders[i-1].status)?'preparing':'ready')!==(o.status==='received'?'received':['accepted','preparing'].includes(o.status)?'preparing':'ready'))&&<h2 className="order-group-title">{o.status==='received'?'Nuevos':['accepted','preparing'].includes(o.status)?'En preparación':'Listos para llevar'}</h2>}<article className="op-order" key={o.id}>
        <div className="op-orderhead"><strong>#{o.id.slice(0,8)} · {o.customer_name}</strong><div className="op-order-head-tools"><span className={`op-status op-status-${o.status}`}>{statusLabel}</span>{['received','accepted','preparing','ready'].includes(o.status)&&<details className="order-more-options"><summary aria-label="Más opciones del pedido" title="Más opciones">⋮</summary><div className="order-more-menu"><button type="button" disabled={busy} onClick={()=>{if(window.confirm('¿Cancelar este pedido? Se liberarán las reservas.'))void act(o.id,'cancel');}}>Cancelar pedido</button></div></details>}</div></div>
        <p className="op-order-contact">{o.customer_phone}{o.delivery_address?` · ${o.delivery_address}`:''}</p>
        <details className="op-order-detail"><summary><span>Productos <small>{linesForOrder.length===1?'1 producto':`${linesForOrder.length} productos`}</small></span></summary><div className="op-order-items">
          {linesForOrder.length===0
            ? <p className="op-item-missing">No se encontró el detalle de este pedido. Verificá antes de prepararlo.</p>
            : linesForOrder.map(l=>{
                const variant=variantLabels[l.variant_id];
                const unit=variant?.base_unit&&variant.base_unit in unitLabels?unitLabels[variant.base_unit as InventoryUnit]:'unidad';
                const canAdjustPrice=staffRole==='admin'&&['received','accepted','preparing','ready'].includes(o.status);
                return <div className="op-order-item" key={l.variant_id}>
                  <span><b>{variant?.name||'Producto no disponible en catálogo'}</b><small>{Number(l.quantity)} {unit} × {cash(Number(l.unit_price_cents))}</small></span>
                  <div className="op-order-item-actions"><strong>{cash(Number(l.line_total_cents))}</strong>{canAdjustPrice&&<details className="order-line-more"><summary aria-label="Más acciones del producto" title="Más acciones">⋮</summary><div className="order-line-menu"><button type="button" onClick={()=>openPriceEditor(o,l)}>Editar precio</button></div></details>}</div>
                </div>;
              })}
        </div></details>
        {hasDeliveryDetails&&<details className="op-order-extra"><summary>Entrega y pago</summary><OrderDeliveryInfo info={deliveryDetails} totalCents={Number(o.total_cents)} showNotes/></details>}
        <div className="op-orderfoot"><div><small className="op-order-total-label">Total</small><strong>{cash(Number(o.total_cents))}</strong></div><small>{new Date(o.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}</small></div><div className="op-actions">
        {o.status==='received'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'accept')}>Aceptar pedido</button>}
        {o.status==='accepted'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'prepare')}>Continuar preparación</button>}
        {o.status==='preparing'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'ready')}>Marcar listo</button>}
        {o.status==='delivered'&&<div className="op-payment-status"><span>Estado del pago</span><strong>{paymentLabel(o.id)}</strong>{pendingFor(o.id)&&!paymentFor(o.id)&&<span>Saldo por cobrar: {cash(Number(o.total_cents))}</span>}</div>}
        {staffRole==='admin'&&o.status==='delivered'&&paymentFor(o.id)?.method==='transfer_reported'&&!paymentFor(o.id)?.verified_at&&(
          issueFor(o.id)?.action==='reported'
          ? <button type="button" className="op-outline" disabled={busy} onClick={()=>openIssue(o.id,'resolved')}>Resolver problema</button>
          : <button type="button" className="op-outline" disabled={busy} onClick={()=>openIssue(o.id,'reported')}>Reportar problema</button>
        )}
        {o.status==='delivered'&&pendingFor(o.id)&&!paymentFor(o.id)&&<button type="button" className="op-primary" disabled={busy||!!paymentAttempt} onClick={()=>openPayment(o.id)}>Registrar cobro</button>}
        
      </div></article></Fragment>})}</section></>}
    </div>
    {priceEditor&&staffRole==='admin'&&<div className="op-payment-backdrop"><div className="op-payment-dialog" role="dialog" aria-modal="true" aria-labelledby="op-price-title">
      <h2 id="op-price-title">Editar precio del pedido</h2>
      <p>Pedido #{priceEditor.order.id.slice(0,8)} · {priceEditor.order.customer_name}</p>
      <div className="op-payment-total"><span>Precio actual por unidad</span><strong>{cash(Number(priceEditor.line.unit_price_cents))}</strong></div>
      <label className="op-issue-label" htmlFor="op-price-new">Nuevo precio por unidad (Q)</label>
      <input id="op-price-new" type="number" inputMode="decimal" min="0" max="1000000" step="0.01" value={priceDraft} disabled={busy} onChange={e=>setPriceDraft(e.target.value)} />
      <label className="op-issue-label" htmlFor="op-price-reason">Acuerdo o motivo</label>
      <textarea id="op-price-reason" rows={3} maxLength={250} value={priceReason} disabled={busy} onChange={e=>setPriceReason(e.target.value)} placeholder="Ej. Precio por volumen acordado por WhatsApp" />
      <p className="op-payment-warning">El cambio afecta únicamente este pedido. No modifica el catálogo ni el costo del inventario. Se guardará quién autorizó el ajuste.</p>
      <div className="op-payment-actions"><button type="button" className="op-outline" disabled={busy} onClick={()=>setPriceEditor(null)}>Cancelar</button><button type="button" className="op-primary" disabled={busy||priceReason.trim().length<3||priceDraft.trim()===''} onClick={()=>void saveOrderLinePrice()}>{busy?'Guardando…':'Guardar precio'}</button></div>
    </div></div>}
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

