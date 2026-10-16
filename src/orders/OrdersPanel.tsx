import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import './orders.css';

type Product = { id:string; name:string; unit:'lb'|'unit'|'package'; price_cents:number; stock:number };
type Order = {id:string;created_at:string;customer_name:string;customer_phone:string;delivery_address:string;notes:string;status:string;total_cents:number};
type Item = {variant_id:string;quantity:number};
type OrderLine = {order_id:string;variant_id:string;quantity:number;unit_price_cents:number;line_total_cents:number};
type VariantLabel = {id:string;name:string;base_unit:string};
const activeStatuses = ['received','accepted','preparing','ready','out_for_delivery'];
const cash=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const units:Record<Product['unit'],string>={lb:'lb',unit:'unidad',package:'paquete'};
const message=(error:unknown)=>{
  if (error && typeof error==='object' && 'message' in error) return String(error.message);
  return 'No se pudo completar la operación.';
};

export function OrdersPanel(){
  const [view,setView]=useState<'customer'|'counter'>('counter');
  const [products,setProducts]=useState<Product[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [orderLines,setOrderLines]=useState<OrderLine[]>([]);
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
    const [variants,lots,orderResult]=await Promise.all([
      supabase.from('product_variants').select('id,name,base_unit,price_cents').eq('active',true),
      supabase.from('inventory_lots').select('variant_id,qty_on_hand,qty_reserved,status,use_by'),
      supabase.from('customer_orders').select('id,created_at,customer_name,customer_phone,delivery_address,notes,status,total_cents').order('created_at',{ascending:false}).limit(60)
    ]);
    const failure=variants.error||lots.error||orderResult.error;
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
    setOrders(fetchedOrders);setError('');
  },[]);
  useEffect(()=>{void load();},[load]);
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
  const activeOrders=orders.filter(o=>activeStatuses.includes(o.status)).sort((a,b)=>a.created_at.localeCompare(b.created_at));
  const historyOrders=orders.filter(o=>!activeStatuses.includes(o.status));
  const visibleOrders=orderFilter==='active'?activeOrders:historyOrders;
  return <div className="orders-module">
    <div className="op-main"><div className="op-head"><div><h1>Pedidos</h1><p>Recepción y aceptación de pedidos de prueba.</p></div><button className="op-outline" onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
      <div className="op-tabs"><button className={view==='customer'?'on':''} onClick={()=>setView('customer')}>Crear pedido de prueba</button><button className={view==='counter'?'on':''} onClick={()=>setView('counter')}>Pedidos ({activeOrders.length})</button></div>
      <p className="op-caution">Solo para pruebas internas. La tienda pública para clientes todavía no está habilitada.</p>
      {error&&<div className="op-error" role="alert">{error}<button onClick={()=>setError('')}>Cerrar</button></div>}
      {notice&&<div className="op-success" role="status">{notice}<button onClick={()=>setNotice('')}>Cerrar</button></div>}
      {view==='customer'?<div className="op-columns"><section><h2>Productos</h2><div className="op-products">{products.map(p=>{
        const qty=items.find(x=>x.variant_id===p.id)?.quantity||0;const increment=p.unit==='lb'?0.5:1;
        return <div className="op-product" key={p.id}><div><strong>{p.name}</strong><small>{cash(p.price_cents)} / {units[p.unit]} · {p.stock} disponibles</small></div><div className="op-qty"><button aria-label={'Quitar '+p.name} onClick={()=>adjust(p,-increment)} disabled={busy||qty===0}>−</button><span>{qty}</span><button aria-label={'Agregar '+p.name} onClick={()=>adjust(p,increment)} disabled={busy||qty+increment>p.stock}>+</button></div></div>;
      })}</div></section><form className="op-form" onSubmit={e=>void submit(e)}><h2>Datos del pedido</h2><label>Nombre<input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={120} required/></label><label>Teléfono<input value={phone} onChange={e=>setPhone(e.target.value)} minLength={8} maxLength={22} required/></label><label>Dirección de entrega<textarea value={address} onChange={e=>setAddress(e.target.value)} minLength={5} maxLength={300} required rows={2}/></label><label>Indicaciones (opcional)<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500} rows={2}/></label><div className="op-total"><span>Total estimado</span><strong>{cash(total)}</strong></div><button className="op-primary" disabled={busy||items.length===0}>{busy?'Enviando…':'Crear pedido de prueba'}</button><small>El inventario se reserva únicamente cuando mostrador acepta el pedido.</small></form></div>
      :<><div className="op-filter-tabs" role="group" aria-label="Filtrar pedidos">
        <button className={orderFilter==='active'?'on':''} onClick={()=>setOrderFilter('active')}>Activos ({activeOrders.length})</button>
        <button className={orderFilter==='history'?'on':''} onClick={()=>setOrderFilter('history')}>Historial ({historyOrders.length})</button>
      </div><section className="op-orders">{visibleOrders.length===0?<p className="op-empty">{orderFilter==='active'?'No hay pedidos pendientes.':'No hay pedidos en el historial reciente.'}</p>:visibleOrders.map(o=><article className="op-order" key={o.id}><div className="op-orderhead"><strong>#{o.id.slice(0,8)} · {o.customer_name}</strong><span>{({received:'Recibido',accepted:'Aceptado',preparing:'En preparación',ready:'Listo',out_for_delivery:'En reparto',delivered:'Entregado',cancelled:'Cancelado'} as Record<string,string>)[o.status]||o.status}</span></div><p>{o.customer_phone} · {o.delivery_address}</p>
        <div className="op-order-items"><strong>Productos solicitados</strong>
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
        </div>
        {o.notes&&<p className="op-notes"><strong>Indicaciones:</strong> {o.notes}</p>}<div className="op-orderfoot"><strong>{cash(Number(o.total_cents))}</strong><small>{new Date(o.created_at).toLocaleString('es-GT')}</small></div><div className="op-actions">
        {o.status==='received'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'accept')}>Aceptar pedido</button>}
        {o.status==='accepted'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'prepare')}>Continuar preparación (pedido anterior)</button>}
        {o.status==='preparing'&&<button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'ready')}>Marcar listo</button>}
        {['received','accepted','preparing','ready'].includes(o.status)&&<button className="op-outline" disabled={busy} onClick={()=>{if(window.confirm('¿Cancelar este pedido? Se liberarán las reservas.'))void act(o.id,'cancel');}}>Cancelar pedido</button>}
        {o.status==='ready'&&<small>Listo para asignar a reparto.</small>}
      </div></article>)}</section></>}
    </div>
  </div>;
}

