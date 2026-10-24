import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import './admin.css';
type Variant={id:string;name:string;base_unit:string;price_cents:number;family_id:string;active:boolean};
type Family={id:string;name:string};
export function AdminPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [variants,setVariants]=useState<Variant[]>([]);const [families,setFamilies]=useState<Family[]>([]);
 const [mode,setMode]=useState<'purchase'|'price'>('purchase');const [variantId,setVariantId]=useState('');
 const [quantity,setQuantity]=useState('');const [cost,setCost]=useState('');const [price,setPrice]=useState('');const [expiry,setExpiry]=useState('');
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
 useEffect(()=>{let live=true;async function load(){if(!supabase)return;const [v,f]=await Promise.all([supabase.from('product_variants').select('id,name,base_unit,price_cents,family_id,active').eq('active',true),supabase.from('product_families').select('id,name')]);if(live){if(v.error||f.error)setError(v.error?.message||f.error?.message||'Error');else {setVariants(v.data||[]);setFamilies(f.data||[]);}}}void load();return()=>{live=false}},[]);
 const selected=variants.find(v=>v.id===variantId);const familyNames=new Map(families.map(f=>[f.id,f.name]));
 const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
 async function submit(){if(!supabase||busy||!selected)return;setError('');setNotice('');
 const num=Number(quantity.replace(',','.'));const cents=Math.round(Number(cost.replace(',','.'))*100);const newPrice=Math.round(Number(price.replace(',','.'))*100);
 if(mode==='purchase'&&(!Number.isFinite(num)||num<=0||num>100000||Math.round(num*10000)!==num*10000||!Number.isFinite(cents)||cents<0||!cost.trim()||(selected.base_unit!=='lb'&&!Number.isInteger(num)))){setError('Revisá cantidad y costo.');return;}
 if(mode==='price'&&(!price.trim()||!Number.isFinite(newPrice)||newPrice<0)){setError('Ingresá un precio válido.');return;}
 if(!window.confirm(mode==='purchase'?`¿Registrar ${num} ${selected.base_unit} de ${selected.name}?`:`¿Cambiar el precio de ${selected.name} a ${money(newPrice)}?`))return;
 setBusy(true);
 try {const r=mode==='purchase'?await supabase.rpc('admin_register_purchase',{p_request_id:requestId,p_variant_id:variantId,p_quantity:num,p_unit_cost_cents:cents,p_use_by:expiry||null}):await supabase.rpc('admin_update_price',{p_request_id:requestId,p_variant_id:variantId,p_new_price_cents:newPrice});
 if(r.error)throw r.error;
 setNotice(mode==='purchase'?'Compra registrada.':'Precio actualizado.');setRequestId(crypto.randomUUID());setQuantity('');setCost('');setPrice('');setExpiry('');
 if(mode==='price')setVariants(old=>old.map(v=>v.id===variantId?{...v,price_cents:newPrice}:v));await onChanged();
 }catch(e){setError(e instanceof Error?e.message:'No se pudo confirmar. No repitás con otro identificador hasta verificar la operación.');}finally{setBusy(false)}
 }
 return <section className="admin-panel"><div className="admin-switch"><button className={mode==='purchase'?'selected':''} onClick={()=>{setMode('purchase');setError('');setNotice('')}}>Registrar compra</button><button className={mode==='price'?'selected':''} onClick={()=>{setMode('price');setError('');setNotice('')}}>Actualizar precio</button></div>
 <div className="admin-form"><label>Producto<select value={variantId} onChange={e=>setVariantId(e.target.value)} disabled={busy}><option value="">Seleccionar producto</option>{variants.map(v=><option key={v.id} value={v.id}>{familyNames.get(v.family_id)||'Otros'} · {v.name}</option>)}</select></label>
 {selected&&<p className="admin-hint">Precio actual: {money(selected.price_cents)} / {selected.base_unit}</p>}
 {mode==='purchase'?<><label>Cantidad ({selected?.base_unit||'unidad base'})<input inputMode="decimal" value={quantity} onChange={e=>setQuantity(e.target.value)} placeholder="Ej. 50" disabled={busy}/></label><label>Costo por {selected?.base_unit||'unidad'} (Q)<input inputMode="decimal" value={cost} onChange={e=>setCost(e.target.value)} placeholder="Ej. 28.00" disabled={busy}/></label><label>Vencimiento (opcional)<input type="date" value={expiry} onChange={e=>setExpiry(e.target.value)} disabled={busy}/></label></>:<label>Nuevo precio por {selected?.base_unit||'unidad'} (Q)<input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} placeholder="Ej. 45.00" disabled={busy}/></label>}
 {error&&<p role="alert" className="admin-error">{error}</p>}{notice&&<p role="status" className="admin-ok">{notice}</p>}
 <button className="primary" onClick={()=>void submit()} disabled={busy||!variantId}>{busy?'Guardando…':mode==='purchase'?'Confirmar compra':'Guardar precio'}</button>
 <small>Solo Administrador · Ambiente de pruebas. Si la conexión falla después de confirmar, verificá en Supabase antes de intentar de nuevo.</small></div></section>
}
