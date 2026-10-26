import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import './admin.css';
import {saveAdminAttempt,clearAdminAttempt} from './AdminPending';
type Family={id:string;name:string};
type Variant={id:string;family_id:string;name:string;base_unit:string;price_cents:number;active:boolean};
type Action='create_family'|'rename_family'|'create_variant'|'rename_variant'|'set_variant_active';
export function CatalogPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [catalogSearch,setCatalogSearch]=useState('');
 const [families,setFamilies]=useState<Family[]>([]),[variants,setVariants]=useState<Variant[]>([]);
 const [action,setAction]=useState<Action>('create_family'),[familyId,setFamilyId]=useState(''),[variantId,setVariantId]=useState('');
 const [name,setName]=useState(''),[unit,setUnit]=useState('lb'),[price,setPrice]=useState(''),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState<{id:string;payload:Record<string,unknown>}|null>(null);
 async function load(){if(!supabase)return;const [f,v]=await Promise.all([supabase.from('product_families').select('id,name').order('name'),supabase.from('product_variants').select('id,family_id,name,base_unit,price_cents,active').order('name')]);if(f.error||v.error){setError(f.error?.message||v.error?.message||'No se pudo cargar catálogo');return;}setFamilies(f.data||[]);setVariants(v.data||[])}
 useEffect(()=>{void load()},[]);
 const selected=variants.find(v=>v.id===variantId);
 function switchAction(next:Action){setAction(next);setName('');setError('');setNotice('');setPending(null)}
 async function submit(){if(!supabase||busy)return;setError('');setNotice('');
 const cents=price.trim()?Math.round(Number(price.replace(',','.'))*100):null;
 if(action!=='set_variant_active'&&(!name.trim()||name.trim().length>100)){setError('Ingresá un nombre válido.');return}
 if(action==='create_variant'&&(cents===null||!Number.isSafeInteger(cents)||cents<0)){setError('Ingresá un precio válido.');return}
 if((action==='rename_family'||action==='create_variant')&&!familyId){setError('Seleccioná una familia.');return}
 if((action==='rename_variant'||action==='set_variant_active')&&!selected){setError('Seleccioná una presentación.');return}
 const active=action==='set_variant_active'?!selected!.active:null;
 const payload={p_request_id:pending?.id||crypto.randomUUID(),p_action:action,p_family_id:action==='rename_family'||action==='create_variant'?familyId:null,p_variant_id:action==='rename_variant'||action==='set_variant_active'?variantId:null,p_name:action==='set_variant_active'?null:name.trim(),p_base_unit:action==='create_variant'?unit:null,p_price_cents:action==='create_variant'?cents:null,p_active:active};
 if(pending&&JSON.stringify(payload)!==JSON.stringify(pending.payload)){setError('Hay una operación sin confirmar. Verificá su resultado antes de cambiar los datos o repetirla.');return}
 if(!window.confirm(action==='set_variant_active'?`¿${active?'Reactivar':'Desactivar'} ${selected?.name}?`:'¿Confirmar cambio en el catálogo?'))return;
 setPending({id:payload.p_request_id,payload});setBusy(true);
 try{const attempt=await saveAdminAttempt('catalog',payload,`Cambio de catálogo: ${action}`);const {error:rpcError}=await supabase.rpc('admin_catalog_change',payload);if(rpcError)throw rpcError;await clearAdminAttempt(attempt);setPending(null);setNotice('Cambio guardado correctamente.');setName('');setPrice('');await load();await onChanged()}
 catch(e){setError((e instanceof Error?e.message:'No se pudo confirmar')+'. Salí y volvé a entrar a Administración para verificar el intento.');}
 finally{setBusy(false)}
 }
 const filtered=variants.filter(v=>!familyId||v.family_id===familyId);
 return <section className="admin-panel catalog-management"><details className="work-disclosure"><summary><strong>Modificar el catálogo</strong><span>Crear, editar o desactivar →</span></summary><div className="admin-form"><h2>Productos y presentaciones</h2>
 <label>Acción<select value={action} onChange={e=>switchAction(e.target.value as Action)} disabled={busy||!!pending}><option value="create_family">Crear producto</option><option value="rename_family">Cambiar nombre de producto</option><option value="create_variant">Agregar presentación</option><option value="rename_variant">Cambiar nombre de presentación</option><option value="set_variant_active">Desactivar / reactivar presentación</option></select></label>
 {action!=='create_family'&&<label>Producto<select value={familyId} onChange={e=>{setFamilyId(e.target.value);setVariantId('')}} disabled={busy||!!pending}><option value="">Seleccionar</option>{families.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select></label>}
 {(action==='rename_variant'||action==='set_variant_active')&&<label>Presentación<select value={variantId} onChange={e=>setVariantId(e.target.value)} disabled={busy||!!pending}><option value="">Seleccionar</option>{filtered.map(v=><option key={v.id} value={v.id}>{v.name} · {v.active?'Activa':'Inactiva'}</option>)}</select></label>}
 {action!=='set_variant_active'&&<label>{action==='create_variant'||action==='rename_variant'?'Nombre de presentación':'Nombre del producto'}<input value={name} onChange={e=>setName(e.target.value)} disabled={busy||!!pending} placeholder="Ej. Camarón grande"/></label>}
 {action==='create_variant'&&<><label>Unidad<select value={unit} onChange={e=>setUnit(e.target.value)} disabled={busy||!!pending}><option value="lb">Libra (lb)</option><option value="unit">Unidad</option><option value="package">Paquete</option></select></label><label>Precio por unidad (Q)<input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)} disabled={busy||!!pending}/></label></>}
 {action==='set_variant_active'&&selected&&<p className="admin-hint">Estado actual: {selected.active?'Activa':'Inactiva'}. Los registros anteriores se conservan.</p>}
 {error&&<p role="alert" className="admin-error">{error}</p>}{notice&&<p role="status" className="admin-ok">{notice}</p>}
 <button className="primary" onClick={()=>void submit()} disabled={busy||!!pending&&!error}>{busy?'Guardando…':action==='set_variant_active'?(selected?.active?'Desactivar':'Reactivar'):'Guardar cambio'}</button>
 {pending&&<p className="admin-hint">Si falló la conexión, no iniciés otro cambio. Revisá el historial en Supabase con el identificador de solicitud antes de repetir.</p>}
 <small>Solo Administrador. Desactivar una presentación no elimina ventas ni inventario anteriores.</small>
 </div></details><label className="module-search"><span className="sr-only">Buscar en catálogo</span><input type="search" value={catalogSearch} onChange={e=>setCatalogSearch(e.target.value)} placeholder="Buscar producto o presentación"/></label><div className="catalog-records">{variants.filter(v=>`${families.find(f=>f.id===v.family_id)?.name||''} ${v.name}`.toLowerCase().includes(catalogSearch.trim().toLowerCase())).map(v=><article className="catalog-record" key={v.id}><div><strong>{families.find(f=>f.id===v.family_id)?.name} · {v.name}</strong><small>{v.active?'Activa':'Inactiva'} · {v.base_unit}</small></div><strong>Q {(v.price_cents/100).toFixed(2)}</strong></article>)}</div>{variants.length===0&&<p className="module-caption">Todavía no hay presentaciones registradas.</p>}</section>
}
