import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import './admin.css';
import {saveAdminAttempt,clearAdminAttempt} from './AdminPending';
type Variant={id:string;name:string;family_id:string;base_unit:string;active:boolean};
type Lot={variant_id:string;qty_on_hand:number;qty_reserved:number;status:string;use_by:string|null};
type Pending={id:string;variantId:string;quantity:number;reason:string;note:string};
export function InventoryAdjustmentPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [variants,setVariants]=useState<Variant[]>([]),[families,setFamilies]=useState<Record<string,string>>({}),[lots,setLots]=useState<Lot[]>([]);
 const [variantId,setVariantId]=useState(''),[quantity,setQuantity]=useState(''),[reason,setReason]=useState('waste'),[note,setNote]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<Pending|null>(null);
 async function load(){if(!supabase)return;const [v,f,l]=await Promise.all([
  supabase.from('product_variants').select('id,name,family_id,base_unit,active').eq('active',true),
  supabase.from('product_families').select('id,name'),
  supabase.from('inventory_lots').select('variant_id,qty_on_hand,qty_reserved,status,use_by')]);
  if(v.error||f.error||l.error){setError(v.error?.message||f.error?.message||l.error?.message||'Error cargando inventario');return}
  setVariants(v.data||[]);setFamilies(Object.fromEntries((f.data||[]).map(x=>[x.id,x.name])));setLots(l.data||[]);
 }
 useEffect(()=>{void load()},[]);
 const selected=variants.find(v=>v.id===variantId);
 const available=lots.filter(l=>l.variant_id===variantId&&l.status==='available'&&(!l.use_by||l.use_by>=new Date().toLocaleDateString('en-CA'))).reduce((s,l)=>s+Math.max(0,Number(l.qty_on_hand)-Number(l.qty_reserved)),0);
 async function submit(){if(!supabase||busy||!selected)return;setError('');setNotice('');
  const amount=Number(quantity.replace(',','.'));const trimmed=note.trim();
  if(!Number.isFinite(amount)||amount<=0||amount>100000||Math.abs(amount*10000-Math.round(amount*10000))>0.000001||(selected.base_unit!=='lb'&&!Number.isInteger(amount))){setError('Ingresá una cantidad válida.');return}
  if(amount>available+0.0000001){setError('La cantidad supera el inventario disponible sin reservas.');return}
  if(trimmed.length>250){setError('La nota debe tener 250 caracteres o menos.');return}
  const payload={variantId,quantity:amount,reason,note:trimmed};
  if(pending&&(pending.variantId!==payload.variantId||pending.quantity!==payload.quantity||pending.reason!==payload.reason||pending.note!==payload.note)){
   setError('Hay un intento sin confirmar. No cambiés los datos antes de verificarlo.');return;
  }
  if(!window.confirm(`¿Descontar ${amount} ${selected.base_unit} de ${selected.name}?`))return;
  const id=pending?.id||crypto.randomUUID();setPending({id,...payload});setBusy(true);
  try{
   const attempt=await saveAdminAttempt('adjustment',{p_request_id:id,p_variant_id:variantId,p_quantity:amount,p_reason:reason,p_note:trimmed||null},`Ajuste de ${amount} ${selected.base_unit} de ${selected.name}`);
   const r=await supabase.rpc('admin_reduce_inventory',{p_request_id:id,p_variant_id:variantId,p_quantity:amount,p_reason:reason,p_note:trimmed||null});
   if(r.error)throw r.error;
   await clearAdminAttempt(attempt);
   setPending(null);setQuantity('');setNote('');setNotice('Ajuste registrado.');await Promise.all([load(),onChanged()]);
  }catch(e){setError((e instanceof Error?e.message:'No se pudo confirmar')+'. Salí y volvé a entrar a Administración para verificar antes de reintentar.');}
  finally{setBusy(false)}
 }
 return <section className="admin-panel"><div className="admin-form">
  <h3>Ajustar inventario</h3><p className="admin-hint">Descontá únicamente mercadería disponible. Los pedidos reservados no se afectan.</p>
  <label>Producto<select value={variantId} disabled={busy||!!pending} onChange={e=>setVariantId(e.target.value)}><option value="">Seleccionar producto</option>{variants.map(v=><option key={v.id} value={v.id}>{families[v.family_id]||'Otros'} · {v.name}</option>)}</select></label>
  {selected&&<p className="admin-hint">Disponible sin reservas: {available.toFixed(4)} {selected.base_unit}</p>}
  <label>Cantidad a descontar ({selected?.base_unit||'unidad'})<input inputMode="decimal" value={quantity} disabled={busy||!!pending} onChange={e=>setQuantity(e.target.value)} placeholder="Ej. 2"/></label>
  <label>Motivo<select value={reason} disabled={busy||!!pending} onChange={e=>setReason(e.target.value)}><option value="waste">Merma o producto dañado</option><option value="count_difference">Diferencia de inventario</option><option value="other">Otro motivo</option></select></label>
  <label>Nota (opcional)<input value={note} disabled={busy||!!pending} onChange={e=>setNote(e.target.value)} maxLength={250} placeholder="Ej. Producto dañado"/></label>
  {error&&<p role="alert" className="admin-error">{error}</p>}{notice&&<p role="status" className="admin-ok">{notice}</p>}
  <button className="primary" disabled={busy||!variantId} onClick={()=>void submit()}>{busy?'Registrando…':pending?'Reintentar mismo ajuste':'Confirmar ajuste'}</button>
  {pending&&<p className="admin-error">Intento pendiente: {pending.id.slice(0,8)}. No iniciés otro ajuste hasta verificar el resultado en Supabase.</p>}
  <small>Solo Administrador · QA. Si la conexión falla, verificá el ajuste antes de repetirlo.</small>
 </div></section>;
}
