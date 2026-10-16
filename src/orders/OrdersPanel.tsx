import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import './orders.css';

type Product = { id:string; name:string; unit:'lb'|'unit'|'package'; price_cents:number; stock:number };
type Order = {id:string;created_at:string;customer_name:string;customer_phone:string;delivery_address:string;notes:string;status:string;total_cents:number};
type Item = {variant_id:string;quantity:number};
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
    setOrders(orderResult.data||[]);setError('');
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
  async function act(id:string,action:'accept'|'cancel'){
    if(!supabase||busy)return;
    setBusy(true);setError('');setNotice('');
    const {error:failure}=await supabase.rpc(action==='accept'?'accept_pilot_order':'cancel_pilot_order',{p_order_id:id});
    if(failure)setError(message(failure));else setNotice(action==='accept'?'Pedido aceptado. Inventario reservado.':'Pedido cancelado. Reservas liberadas.');
    await load();setBusy(false);
  }
  return <div className="orders-module">
    <div className="op-main"><div className="op-head"><div><h1>Pedidos</h1><p>Recepción y aceptación de pedidos de prueba.</p></div><button className="op-outline" onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
      <div className="op-tabs"><button className={view==='customer'?'on':''} onClick={()=>setView('customer')}>Crear pedido de prueba</button><button className={view==='counter'?'on':''} onClick={()=>setView('counter')}>Bandeja ({orders.filter(o=>o.status==='received').length})</button></div>
      <p className="op-caution">Solo para pruebas internas. La tienda pública para clientes todavía no está habilitada.</p>
      {error&&<div className="op-error" role="alert">{error}<button onClick={()=>setError('')}>Cerrar</button></div>}
      {notice&&<div className="op-success" role="status">{notice}<button onClick={()=>setNotice('')}>Cerrar</button></div>}
      {view==='customer'?<div className="op-columns"><section><h2>Productos</h2><div className="op-products">{products.map(p=>{
        const qty=items.find(x=>x.variant_id===p.id)?.quantity||0;const increment=p.unit==='lb'?0.5:1;
        return <div className="op-product" key={p.id}><div><strong>{p.name}</strong><small>{cash(p.price_cents)} / {units[p.unit]} · {p.stock} disponibles</small></div><div className="op-qty"><button aria-label={'Quitar '+p.name} onClick={()=>adjust(p,-increment)} disabled={busy||qty===0}>−</button><span>{qty}</span><button aria-label={'Agregar '+p.name} onClick={()=>adjust(p,increment)} disabled={busy||qty+increment>p.stock}>+</button></div></div>;
      })}</div></section><form className="op-form" onSubmit={e=>void submit(e)}><h2>Datos del pedido</h2><label>Nombre<input value={name} onChange={e=>setName(e.target.value)} minLength={2} maxLength={120} required/></label><label>Teléfono<input value={phone} onChange={e=>setPhone(e.target.value)} minLength={8} maxLength={22} required/></label><label>Dirección de entrega<textarea value={address} onChange={e=>setAddress(e.target.value)} minLength={5} maxLength={300} required rows={2}/></label><label>Indicaciones (opcional)<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500} rows={2}/></label><div className="op-total"><span>Total estimado</span><strong>{cash(total)}</strong></div><button className="op-primary" disabled={busy||items.length===0}>{busy?'Enviando…':'Crear pedido de prueba'}</button><small>El inventario se reserva únicamente cuando mostrador acepta el pedido.</small></form></div>
      :<section className="op-orders">{orders.length===0?<p>No hay pedidos todavía.</p>:orders.map(o=><article className="op-order" key={o.id}><div className="op-orderhead"><strong>#{o.id.slice(0,8)} · {o.customer_name}</strong><span>{o.status}</span></div><p>{o.customer_phone} · {o.delivery_address}</p>{o.notes&&<p>Nota: {o.notes}</p>}<div className="op-orderfoot"><strong>{cash(Number(o.total_cents))}</strong><small>{new Date(o.created_at).toLocaleString('es-GT')}</small></div>{o.status==='received'&&<div className="op-actions"><button className="op-primary" disabled={busy} onClick={()=>void act(o.id,'accept')}>Aceptar y reservar</button><button className="op-outline" disabled={busy} onClick={()=>void act(o.id,'cancel')}>Cancelar</button></div>}{o.status==='accepted'&&<button className="op-outline" disabled={busy} onClick={()=>void act(o.id,'cancel')}>Cancelar y liberar reserva</button>}</article>)}</section>}
    </div>
  </div>;
}

