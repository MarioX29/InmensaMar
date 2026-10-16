import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ShoppingBasket, Package, ClipboardList, BarChart3, Search, Plus, Minus, X, Check, RefreshCw, Truck } from 'lucide-react';
import { AuthGate } from './auth/AuthGate';
import { supabase } from './lib/supabase';
import { errorMessage, isDefinitiveStockRejection } from './lib/checkoutErrors';
import { nextCartQuantity, cartExceedsStock } from './lib/cartRules';
import './styles.css';
import { OrdersPanel } from './orders/OrdersPanel';
import { DeliveryPanel } from './delivery/DeliveryPanel';

type Product = { id: string; name: string; family: string; unit: 'lb'|'unit'|'package'; priceCents: number; stock: number };
type Line = { id: string; qty: number };
type Sale = { id: string; created_at: string; total_cents: number; status: string };
type Page = 'vender'|'pedidos'|'reparto'|'inventario'|'resumen';
type Receipt = { saleId:string; totalCents:number; cashCents:number };
type PendingCheckout = { requestId: string; paymentId: string; items: {variant_id:string;quantity:number}[]; cashCents:number; saleId?:string };
const money = (cents:number) => `Q ${(cents/100).toFixed(2)}`;
const units: Record<Product['unit'],string> = {lb:'lb',unit:'unidad',package:'paquete'};
const step = (p:Product) => p.unit === 'lb' ? 0.5 : 1;
const pendingKey = 'im-pending-checkout-v03';
function readPending(): PendingCheckout|null { try {const v=localStorage.getItem(pendingKey);return v?JSON.parse(v) as PendingCheckout:null;} catch {return null;} }
function friendlyError(message:string) {
  if (/Insufficient available inventory/i.test(message)) return 'No hay suficiente inventario disponible. Actualizá el catálogo.';
  if (/Product unavailable/i.test(message)) return 'Este producto ya no está disponible.';
  if (/Payment exceeds outstanding balance/i.test(message)) return 'El cobro supera el saldo de la venta.';
  if (/JWT|unauthorized|permission|not authorized/i.test(message)) return 'No tenés permisos para esta operación. Revisá tu sesión.';
  return `No se completó la operación: ${message}`;
}
function App({staffRole='admin'}:{staffRole?:'admin'|'counter'|'driver'}) {
  const [page,setPage]=useState<Page>(staffRole==='driver'?'reparto':'vender');
  const [products,setProducts]=useState<Product[]>([]);
  const [sales,setSales]=useState<Sale[]>([]);
  const [lines,setLines]=useState<Line[]>([]);
  const [query,setQuery]=useState('');
  const [category,setCategory]=useState('Todos');
  const [cartOpen,setCartOpen]=useState(false);
  const [cash,setCash]=useState('');
  const [notice,setNotice]=useState('');
  const [receipt,setReceipt]=useState<Receipt|null>(null);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [pending,setPending]=useState<PendingCheckout|null>(readPending);
  const [checkingPending,setCheckingPending]=useState(false);
  const processing=useRef(false);
  const cart=useMemo(()=>lines.map(l=>({line:l,product:products.find(p=>p.id===l.id)})).filter((x):x is {line:Line;product:Product}=>Boolean(x.product)),[lines,products]);
  const totalCents=cart.reduce((s,x)=>s+Math.round(x.line.qty*x.product.priceCents),0);
  const categories=['Todos',...new Set(products.map(p=>p.family))];
  const refresh=useCallback(async()=>{
    if(!supabase)return;
    const [families,variants,lots,history]=await Promise.all([
      supabase.from('product_families').select('id,name'),
      supabase.from('product_variants').select('id,family_id,name,base_unit,price_cents,active').eq('active',true),
      supabase.from('inventory_lots').select('variant_id,qty_on_hand,qty_reserved,status,use_by'),
      supabase.from('sales').select('id,created_at,total_cents,status').order('created_at',{ascending:false}).limit(100),
    ]);
    const issue=[families,variants,lots,history].find(r=>r.error)?.error;
    if(issue) {setError(friendlyError(issue.message));setLoading(false);return;}
    const familyNames=new Map((families.data||[]).map(f=>[f.id,f.name]));
    const today=new Date().toLocaleDateString('en-CA');
    const stock=new Map<string,number>();
    for(const lot of lots.data||[]) {
      if(lot.status!=='available'||(lot.use_by&&lot.use_by<today))continue;
      stock.set(lot.variant_id,(stock.get(lot.variant_id)||0)+Number(lot.qty_on_hand)-Number(lot.qty_reserved));
    }
    setProducts((variants.data||[]).map(v=>({id:v.id,name:v.name,family:familyNames.get(v.family_id)||'Otros',unit:v.base_unit as Product['unit'],priceCents:v.price_cents,stock:Math.max(0,Math.round((stock.get(v.id)||0)*10000)/10000)})));
    setSales(history.data||[]);setLoading(false);
  },[]);
  useEffect(()=>{void refresh();const timer=setInterval(()=>{if(!document.hidden&&!processing.current)void refresh();},15000);return()=>clearInterval(timer);},[refresh]);
  function updateCart(p:Product,delta:number) {
    if (pending || busy) return;
    const current=lines.find(l=>l.id===p.id)?.qty||0;
    const next=nextCartQuantity(current,delta,p.stock);
    if(next===null){setError('Inventario insuficiente. Actualizá el catálogo.');return;}
    if(delta>0 && p.stock<=0)return;
    setLines(old=>next<=0?old.filter(l=>l.id!==p.id):old.some(l=>l.id===p.id)?old.map(l=>l.id===p.id?{...l,qty:next}:l):[...old,{id:p.id,qty:next}]);
    setNotice('');setError('');setReceipt(null);
  }
  function add(p:Product){updateCart(p,step(p));}
  function change(p:Product,delta:number){updateCart(p,delta);}
  function removeLine(id:string){if(pending||busy)return;setLines(old=>old.filter(l=>l.id!==id));setError('');setNotice('');setReceipt(null);}
  const staleLines=cart.filter(({line,product})=>cartExceedsStock(line.qty,product.stock));
  function clearAttempt(message: string) {
    localStorage.removeItem(pendingKey);
    setPending(null);
    setLines([]);
    setCash('');
    setCartOpen(false);
    setError('');
    setNotice(message);
  }
  async function verifyPending(){
    if(!supabase || !pending || busy || checkingPending) return;
    setCheckingPending(true);setError('');setNotice('');
    try {
      const saleResult=await supabase.from('sales').select('id,total_cents,status').eq('request_id',pending.requestId).maybeSingle();
      if(saleResult.error) throw saleResult.error;
      if(!saleResult.data){
        setError('No hay una venta registrada con este identificador. Si el intento ya terminó y no se registró un cobro, podés descartarlo después de verificarlo.');
        return;
      }
      const sale=saleResult.data;
      const payments=await supabase.from('sale_payments').select('request_id,amount_cents,status').eq('sale_id',sale.id);
      if(payments.error) throw payments.error;
      const paid=(payments.data||[]).filter(p=>p.status==='received').reduce((sum,p)=>sum+Number(p.amount_cents),0);
      if(sale.status==='completed' && paid===Number(sale.total_cents)){
        clearAttempt('Venta y cobro confirmados en Supabase. Mostrador habilitado.');
        await refresh();
      }else{
        const updated={...pending,saleId:sale.id};
        localStorage.setItem(pendingKey,JSON.stringify(updated));setPending(updated);
        setError(`La venta existe, pero el cobro confirmado es ${money(paid)} de ${money(Number(sale.total_cents))}. No se liberó el bloqueo para evitar duplicaciones.`);
      }
    }catch(e){setError(friendlyError(errorMessage(e)));}
    finally{setCheckingPending(false);}
  }
  async function discardUnregisteredPending(){
    if(!supabase || !pending || busy || checkingPending) return;
    setCheckingPending(true);setError('');
    try {
      const current=pending;
      const result=await supabase.from('sales').select('id').eq('request_id',current.requestId).maybeSingle();
      if(result.error) throw result.error;
      if(result.data){setError('Esta venta sí existe en Supabase. No se puede descartar; verificá su cobro.');return;}
      if(!window.confirm('No se encontró la venta en Supabase. Solo descartá si confirmaste que el intento terminó y no existe un cobro externo. ¿Continuar?'))return;
      clearAttempt('Intento local descartado. No se modificaron ventas ni inventario en Supabase.');
      await refresh();
    }catch(e){setError(friendlyError(errorMessage(e)));}
    finally{setCheckingPending(false);}
  }
  async function checkout(){
    if(!supabase||busy||processing.current)return;
    if(pending){setError('Hay una operación anterior pendiente. Usá Verificar operación pendiente antes de continuar.');return;}
    if(!cart.length)return;
    if(staleLines.length){setError('El inventario cambió. Quitá o reducí los productos agotados antes de cobrar.');await refresh();return;}
    const cashValue=Number(cash);
    if(!cash.trim()||!Number.isFinite(cashValue)||cashValue<0||Math.round(cashValue*100)<totalCents){setError('Ingresá un efectivo recibido igual o mayor al total.');return;}
    const attempt: PendingCheckout={requestId:crypto.randomUUID(),paymentId:crypto.randomUUID(),items:cart.map(({line})=>({variant_id:line.id,quantity:line.qty})),cashCents:Math.round(cashValue*100)};
    processing.current=true;setBusy(true);setError('');
    localStorage.setItem(pendingKey,JSON.stringify(attempt));setPending(attempt);
    try {
      let saleId=attempt.saleId;
      if(!saleId){
        const result=await supabase.rpc('register_counter_sale',{p_request_id:attempt.requestId,p_items:attempt.items});
        if(result.error){
          const msg=errorMessage(result.error);
          if(isDefinitiveStockRejection(msg)){
            localStorage.removeItem(pendingKey);setPending(null);
            setError(friendlyError(msg) + ' La venta no se registró. Corregí el carrito para continuar.');
            await refresh();
            return;
          }
          throw result.error;
        }
        saleId=result.data as string;
        attempt.saleId=saleId;localStorage.setItem(pendingKey,JSON.stringify(attempt));setPending({...attempt});
      }
      const saleResult=await supabase.from('sales').select('total_cents').eq('id',saleId).single();
      if(saleResult.error)throw saleResult.error;
      const due=Number(saleResult.data.total_cents);
      if(attempt.cashCents<due){
        throw new Error(`La venta quedó registrada por ${money(due)}. El efectivo ingresado no alcanza. Contactá al administrador antes de continuar.`);
      }
      const payment=await supabase.rpc('record_sale_payment',{p_request_id:attempt.paymentId,p_sale_id:saleId,p_method:'cash',p_amount_cents:due,p_pending_verification:false});
      if(payment.error)throw payment.error;
      localStorage.removeItem(pendingKey);setPending(null);setLines([]);setCash('');setCartOpen(false);
      setReceipt({saleId,totalCents:due,cashCents:attempt.cashCents});setNotice('');
      await refresh();
    } catch(e) {
      const message=errorMessage(e);
      setError(friendlyError(message));
    }
    finally {processing.current=false;setBusy(false);}
  }
  const filtered=products.filter(p=>(category==='Todos'||p.family===category)&&p.name.toLowerCase().includes(query.toLowerCase()));
  const allNav:[Page,string,React.ReactNode][]=[['vender','Vender',<ShoppingBasket size={19}/>],['pedidos','Pedidos',<ClipboardList size={19}/>],['reparto','Reparto',<Truck size={19}/>],['inventario','Inventario',<Package size={19}/>],['resumen','Resumen',<BarChart3 size={19}/>]];
  const nav = allNav.filter(([id])=>staffRole==='admin'||(staffRole==='driver'?id==='reparto':id!=='resumen'));
  const cartPanel=<section className="cart"><div className="cart-title"><strong>Venta actual</strong><button className="mobile-only icon-btn" aria-label="Cerrar carrito" onClick={()=>setCartOpen(false)}><X size={19}/></button></div>
    {cart.length?cart.map(({line,product})=><div className="cart-line" key={line.id}><div><strong>{product.name}</strong><small>{money(product.priceCents)} / {units[product.unit]}</small></div>{line.qty>product.stock&&<small className="cart-stock-warning">Disponible: {product.stock} {units[product.unit]}. Reducí o quitá este producto.</small>}<div className="cart-bottom"><div className="stepper"><button disabled={busy||!!pending} aria-label="Restar" onClick={()=>change(product,-step(product))}><Minus size={15}/></button><span>{line.qty}</span><button disabled={busy||!!pending} aria-label="Sumar" onClick={()=>change(product,step(product))}><Plus size={15}/></button></div><b>{money(Math.round(line.qty*product.priceCents))}</b><button className="remove-line" type="button" disabled={busy||!!pending} onClick={()=>removeLine(product.id)} aria-label={`Quitar ${product.name}`}>Quitar</button></div></div>):<p className="empty">Agregá productos para comenzar.</p>}
    <div className="cart-checkout"><div className="total"><span>Total estimado</span><strong>{money(totalCents)}</strong></div><label htmlFor="cash">Efectivo recibido (Q)</label><input id="cash" type="number" inputMode="decimal" min="0" step="0.01" value={pending?(pending.cashCents/100).toFixed(2):cash} disabled={busy||!!pending} onChange={e=>setCash(e.target.value)} placeholder="0.00"/><button className="primary" disabled={busy||!!pending||!cart.length||staleLines.length>0} onClick={()=>void checkout()}><Check size={17}/>{busy?'Guardando…':'Registrar venta y cobro'}</button><small>Operaciones de prueba conectadas a Supabase. Solo efectivo en esta versión.</small></div></section>;
  return <div className="shell"><header className="top"><div className="brand"><span className="mark">IM</span><div><strong>Inmensa Mar</strong><small>Operación</small></div></div><span className="demo">ENTORNO DE PRUEBA</span></header><div className="workspace"><aside className="sidebar"><div className="side-label">OPERACIÓN</div>{nav.map(([id,label,icon])=><button key={id} className={page===id?'active':''} onClick={()=>{setPage(id);setCartOpen(false)}}>{icon}{label}</button>)}</aside><main className="main">
    <div className="heading heading-actions"><div><h1>{page==='vender'?'Nueva venta':page==='inventario'?'Inventario':page==='resumen'?'Resumen':page==='reparto'?'Reparto':'Pedidos'}</h1><p>{page==='vender'?'Seleccioná productos y registrá el cobro en Supabase.':page==='inventario'?'Existencias disponibles por variante.':page==='resumen'?'Ventas registradas en la base de datos.':page==='reparto'?'Asignación de rutas y pedidos listos.':'Recepción y preparación de pedidos.'}</p></div><button className="refresh-btn" onClick={()=>void refresh()} disabled={busy}><RefreshCw size={16}/> Actualizar</button></div>
    {error&&<div className="error-panel" role="alert">{error}<button className="dismiss-error" type="button" onClick={()=>setError('')} aria-label="Cerrar error"><X size={16}/></button>{pending&&<p>Hay una operación pendiente de verificar. No iniciés otra venta hasta resolverla.</p>}</div>}
    {receipt&&<div className="receipt-panel" role="status"><strong>Venta y cobro confirmados</strong><span>Venta #{receipt.saleId.slice(0,8)} · Total {money(receipt.totalCents)} · Efectivo {money(receipt.cashCents)} · Vuelto {money(receipt.cashCents-receipt.totalCents)}</span><button className="dismiss-error" type="button" aria-label="Cerrar confirmación" onClick={()=>setReceipt(null)}><X size={16}/></button></div>}
    {pending&&<div className="warning-panel">Hay una operación pendiente. Verificá primero su estado en Supabase. <button type="button" disabled={busy||checkingPending} onClick={()=>void verifyPending()}>{checkingPending?'Verificando…':'Verificar operación pendiente'}</button> <button type="button" disabled={busy||checkingPending} onClick={()=>void discardUnregisteredPending()}>Descartar intento sin venta</button></div>}
    {page==='pedidos'?<OrdersPanel/>:page==='reparto'?<DeliveryPanel staffRole={staffRole}/>:loading?<p className="empty">Cargando datos de Supabase…</p>:page==='vender'?<div className="pos"><section className="catalog"><div className="search"><Search size={18}/><input aria-label="Buscar productos" placeholder="Buscar producto" value={query} onChange={e=>setQuery(e.target.value)}/></div><div className="filters">{categories.map(c=><button key={c} className={category===c?'selected':''} onClick={()=>setCategory(c)}>{c}</button>)}</div><div className="product-list">{filtered.map(p=><div className="product" key={p.id}><div className="product-info"><strong>{p.name}</strong><small>{p.stock<=0?'Agotado':`${p.stock} ${units[p.unit]} disponibles`}</small></div><div className="product-action"><b>{money(p.priceCents)}<small>/{units[p.unit]}</small></b><button aria-label={`Agregar ${p.name}`} disabled={busy||!!pending||p.stock<=0} onClick={()=>add(p)}><Plus size={19}/></button></div></div>)}{!filtered.length&&<p className="empty">No hay productos disponibles. Cargá datos de prueba en Supabase.</p>}</div></section><div className="desktop-cart">{cartPanel}</div></div>:page==='inventario'?<div className="table-wrap"><table><thead><tr><th>Producto</th><th>Unidad</th><th>Precio</th><th>Disponible</th></tr></thead><tbody>{products.map(p=><tr key={p.id}><td>{p.name}</td><td>{units[p.unit]}</td><td>{money(p.priceCents)}</td><td>{p.stock}</td></tr>)}</tbody></table></div>:page==='resumen'?<><div className="stats"><div><small>Últimas ventas</small><strong>{sales.length}</strong></div><div><small>Total registrado (últimas 100)</small><strong>{money(sales.reduce((s,x)=>s+Number(x.total_cents),0))}</strong></div></div><div className="table-wrap"><table><thead><tr><th>Venta</th><th>Fecha</th><th>Total</th></tr></thead><tbody>{sales.map(s=><tr key={s.id}><td>{s.id.slice(0,8)}</td><td>{new Date(s.created_at).toLocaleString('es-GT')}</td><td>{money(Number(s.total_cents))}</td></tr>)}</tbody></table>{!sales.length&&<p className="empty">No hay ventas todavía.</p>}</div></>:<div className="placeholder"><ClipboardList size={28}/><strong>Próxima fase</strong><p>Los pedidos online todavía no están habilitados.</p></div>}
    </main></div>{page==='vender'&&(lines.length>0||pending)&&<button className="mobile-cart-trigger" onClick={()=>setCartOpen(true)}><span>{pending?'Cobro pendiente':`Venta actual · ${lines.length} productos`}</span><strong>{money(totalCents)} →</strong></button>}{cartOpen&&page==='vender'&&<div className="drawer-backdrop" onClick={()=>setCartOpen(false)}><div className="drawer" onClick={e=>e.stopPropagation()}>{cartPanel}</div></div>}<nav className="bottom-nav">{nav.map(([id,label,icon])=><button key={id} className={page===id?'active':''} onClick={()=>{setPage(id);setCartOpen(false)}}>{icon}<span>{label}</span></button>)}</nav>{notice&&<div className="notice" role="status"><span>{notice}</span><button aria-label="Cerrar aviso" onClick={()=>setNotice('')}><X size={16}/></button></div>}</div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><AuthGate><App/></AuthGate></React.StrictMode>);