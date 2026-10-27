import {useEffect,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {attemptKey,receiptKey,readAttempt,readReceipt,sendAttempt,productTotal,confirmedRejections,messages,
 type CatalogProduct,type PublicAttempt,type PublicReceipt} from './orderClient';
import '../ui/theme.css';
import './storefront.css';
type Line={id:string;quantity:number};
const money=(c:number)=>`Q ${(c/100).toFixed(2)}`;
const unit={lb:'lb',unit:'unidad',package:'paquete'};
const searchKey=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
export function Storefront(){
 const [pending,setPending]=useState<PublicAttempt|null>(readAttempt);
 const attempt=useRef<PublicAttempt|null>(pending);const sending=useRef(false);
 const [receipt,setReceipt]=useState<PublicReceipt|null>(()=>pending?null:readReceipt());
 const [products,setProducts]=useState<CatalogProduct[]>([]),[loading,setLoading]=useState(true),[catalogError,setCatalogError]=useState('');
 const [search,setSearch]=useState(''),[cartOpen,setCartOpen]=useState(false),[lines,setLines]=useState<Line[]>(()=>pending?.items.map(i=>({id:i.variant_id,quantity:i.quantity}))||[]);
 const [name,setName]=useState(pending?.customer_name||''),[phone,setPhone]=useState(pending?.customer_phone||'');
 const [address,setAddress]=useState(pending?.delivery_address||''),[notes,setNotes]=useState(pending?.notes||'');
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 const cartPanel=useRef<HTMLElement|null>(null),cartTrigger=useRef<HTMLButtonElement|null>(null);
 async function loadCatalog(){setLoading(true);setCatalogError('');try{
  const response=await fetch('/api/customer-catalog',{cache:'no-store',credentials:'omit'});
  const data=await response.json() as {products?:CatalogProduct[]};
  if(!response.ok||!Array.isArray(data.products)||data.products.some(p=>!p||typeof p.id!=='string'||typeof p.name!=='string'||typeof p.family!=='string'||!['lb','unit','package'].includes(p.unit)||!Number.isSafeInteger(p.price_cents)||p.price_cents<0||typeof p.available!=='boolean'))throw new Error();
  setProducts(data.products);
 }catch{setCatalogError('No pudimos cargar el catálogo. Intentá de nuevo en un momento.')}finally{setLoading(false)}}
 useEffect(()=>{void loadCatalog()},[]);
 useEffect(()=>{
  if(!cartOpen)return;const panel=cartPanel.current;panel?.querySelector<HTMLElement>('button,input')?.focus();
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){setCartOpen(false);cartTrigger.current?.focus()}if(e.key==='Tab'&&panel){const nodes=Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary')).filter(x=>x.getClientRects().length);const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}};
  window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
 },[cartOpen]);
 const frozen=busy||!!pending;
 const total=lines.reduce((s,l)=>s+productTotal(l.quantity,products.find(p=>p.id===l.id)?.price_cents||0),0);
 const stale=lines.some(l=>!products.find(p=>p.id===l.id)?.available);
 function quantity(id:string,n:number){if(frozen)return;const p=products.find(p=>p.id===id);if(!p||!Number.isFinite(n)||n<0||n>1000||Math.round(n*10000)/10000!==n||p.unit!=='lb'&&!Number.isInteger(n)){setError('Revisá la cantidad. En unidades y paquetes usá números enteros.');return}
  setLines(old=>n===0?old.filter(l=>l.id!==id):old.some(l=>l.id===id)?old.map(l=>l.id===id?{...l,quantity:n}:l):old.length>=30?old:[...old,{id,quantity:n}]);setError('');
 }
 async function submit(e?:React.FormEvent){e?.preventDefault();if(sending.current||receipt)return;
  let value=attempt.current;
  if(!value){
   if(!lines.length||stale||loading||catalogError){setError('Revisá los productos disponibles antes de enviar.');return}
   if(name.trim().length<2||!/^\+?[0-9 ()-]{8,22}$/.test(phone.trim())||phone.replace(/[^0-9]/g,'').length<8||phone.replace(/[^0-9]/g,'').length>15||address.trim().length<5){setError('Completá nombre, teléfono y dirección.');return}
   value={request_id:crypto.randomUUID(),customer_name:name.trim(),customer_phone:phone.trim(),delivery_address:address.trim(),notes:notes.trim(),items:lines.map(l=>({variant_id:l.id,quantity:l.quantity,expected_unit_price_cents:products.find(p=>p.id===l.id)!.price_cents}))};
   // Persist before sending. A lost response must never produce a fresh request ID.
   try{sessionStorage.setItem(attemptKey,JSON.stringify(value));sessionStorage.removeItem(receiptKey)}catch{setError('No pudimos guardar el intento en este navegador. Habilitá su almacenamiento antes de enviar.');return}
   attempt.current=value;setPending(value);
  }
  sending.current=true;setBusy(true);setError('');
  try{
   const result=await sendAttempt(value);
   if(result.receipt){
    // Keep the original attempt if saving its receipt fails: retries stay idempotent.
    try{sessionStorage.setItem(receiptKey,JSON.stringify(result.receipt));sessionStorage.removeItem(attemptKey)}catch{/* the request ID remains in memory */}
    setReceipt(result.receipt);setPending(null);attempt.current=null;setLines([]);setCartOpen(false);
   }else{const code=result.code||'RESULT_UNCONFIRMED';
    if(confirmedRejections.has(code)){try{sessionStorage.removeItem(attemptKey)}catch{}attempt.current=null;setPending(null);await loadCatalog()}
    setError(messages[code]||messages.RESULT_UNCONFIRMED);
   }
  }finally{sending.current=false;setBusy(false)}
 }
 function newOrder(){if(busy)return;try{sessionStorage.removeItem(receiptKey);sessionStorage.removeItem(attemptKey)}catch{}setReceipt(null);setLines([]);setName('');setPhone('');setAddress('');setNotes('');setError('');void loadCatalog()}
 return <div className="storefront"><header className="sf-top"><a href="/pedidos.html" className="sf-brand"><img src="/icon-192.png" alt="" width="48" height="48"/><strong>Inmensa Mar<small>Catálogo y pedidos</small></strong></a><span className="sf-local">Catálogo para entrega</span></header>
 <main>{receipt?<section className="sf-receipt" role="status"><p className="sf-receipt-status">Pedido recibido</p><h1>Gracias por tu pedido</h1><p>El negocio confirmará disponibilidad y entrega al teléfono que registraste.</p><dl><div><dt>Referencia</dt><dd>{receipt.order_id.slice(0,8).toUpperCase()}</dd></div><div><dt>Total de productos</dt><dd>{money(receipt.total_cents)}</dd></div></dl><p className="sf-help">Todavía no es un cobro ni una confirmación de entrega.</p><button onClick={newOrder}>Hacer otro pedido</button></section>:<>
 <div className="sf-heading"><div><h1>Hacé tu pedido de mariscos.</h1><p>Lo recibimos y confirmamos antes de prepararlo.</p></div><button className="sf-link" disabled={busy||loading} onClick={()=>void loadCatalog()}>Actualizar catálogo</button></div>
 {catalogError&&<p role="alert" className="sf-error">{catalogError} <button onClick={()=>void loadCatalog()} disabled={loading}>Reintentar</button></p>}
 {pending&&<section className="sf-pending" role="status"><strong>Tu envío está por confirmar</strong><p>Conservamos la misma solicitud para evitar duplicados. No necesitás llenar los datos otra vez.</p><button disabled={busy} onClick={()=>void submit()}>{busy?'Verificando…':'Verificar mi envío'}</button></section>}
 {error&&<p role="alert" className="sf-error">{error}</p>}
 <div className="sf-layout"><section className="sf-catalog" aria-label="Productos"><label className="sf-search">Buscar producto<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Camarón, mojarra, pulpo…"/></label>
 {loading?<p role="status">Cargando catálogo…</p>:<div className="sf-products">{products.filter(p=>searchKey(p.family+' '+p.name).includes(searchKey(search))).map(p=>{const n=lines.find(l=>l.id===p.id)?.quantity||0;return <article className="sf-product" key={p.id}><div><small>{p.family}</small><h2>{p.name}</h2><p><strong>{money(p.price_cents)}</strong> / {unit[p.unit]}</p>{!p.available&&<small>Por ahora no disponible</small>}</div><div className="sf-add">{n>0?<><button disabled={frozen} aria-label={'Quitar '+p.name} onClick={()=>quantity(p.id,Math.max(0,n-(p.unit==='lb'?.5:1)))}>−</button><span>{n} {unit[p.unit]}</span></>:null}<button disabled={frozen||!p.available} onClick={()=>quantity(p.id,n+(p.unit==='lb'?.5:1))}>{n>0?'+':'Agregar'}<span className="sr-only"> {p.name}</span></button></div></article>})}{!products.length&&!catalogError&&<p>No hay productos disponibles por ahora.</p>}</div>}</section>
 <div className={'sf-cart-wrap'+(cartOpen?' is-open':'')}><aside ref={cartPanel} className="sf-cart" aria-label="Tu pedido" role={cartOpen?'dialog':undefined} aria-modal={cartOpen?true:undefined}><div className="sf-cart-head"><h2>Tu pedido</h2><button className="sf-mobile-close sf-link" onClick={()=>setCartOpen(false)}>Volver</button></div>
 <form onSubmit={e=>void submit(e)}><div>{!lines.length?<p className="sf-help">Agregá productos del catálogo.</p>:lines.map(l=>{const p=products.find(x=>x.id===l.id);return <div className="sf-cart-line" key={l.id}><strong>{p?p.family+' · '+p.name:'Producto por actualizar'}</strong><div><label>Cantidad ({p?unit[p.unit]:''})<input key={l.id+'-'+l.quantity} type="number" inputMode="decimal" min="0.0001" max="1000" step={p?.unit==='lb'?'0.0001':'1'} defaultValue={l.quantity} disabled={frozen} onBlur={e=>{const n=Number(e.target.value);if(!e.target.value.trim()||!Number.isFinite(n)||n<=0||n>1000||Math.round(n*10000)/10000!==n||p?.unit!=='lb'&&!Number.isInteger(n)){e.target.value=String(l.quantity);setError('Revisá la cantidad del producto.');return}quantity(l.id,n)}}/></label><span>{p?money(productTotal(l.quantity,p.price_cents)):'—'}</span><button type="button" className="sf-link" disabled={frozen} onClick={()=>quantity(l.id,0)}>Quitar</button></div>{p&&!p.available&&<small className="sf-error">Este producto ya no está disponible.</small>}</div>})}</div>
 <div className="sf-total"><span>Total de productos</span><strong>{products.length?money(total):'—'}</strong></div><p className="sf-help">El negocio confirmará disponibilidad y condiciones de entrega. El envío de este pedido no realiza ningún pago.</p>
 <fieldset disabled={frozen}><legend>Tus datos para la entrega</legend><label>Nombre<input value={name} onChange={e=>setName(e.target.value)} required minLength={2} maxLength={120} autoComplete="name"/></label><label>Teléfono<input type="tel" inputMode="tel" value={phone} onChange={e=>setPhone(e.target.value)} required minLength={8} maxLength={22} autoComplete="tel"/></label><label>Dirección de entrega<textarea value={address} onChange={e=>setAddress(e.target.value)} required minLength={5} maxLength={300} autoComplete="street-address" rows={2}/></label><details><summary>Agregar indicaciones (opcional)</summary><label>Indicaciones<textarea value={notes} onChange={e=>setNotes(e.target.value)} maxLength={500} rows={2}/></label></details></fieldset>
 <button className="sf-primary" type="submit" disabled={busy||!pending&&(!lines.length||loading||!!catalogError||stale)}>{busy?'Enviando…':pending?'Verificar mi envío':'Enviar pedido'}</button>
 </form></aside></div></div>
 <button ref={cartTrigger} className="sf-mobile-cart" onClick={()=>setCartOpen(true)}>Ver mi pedido · {lines.length} productos <strong>{products.length?money(total):'—'}</strong></button>
 </>}</main><footer>Inmensa Mar · Tus datos se usan para atender este pedido.</footer></div>
}
createRoot(document.getElementById('root')!).render(<Storefront/>);
