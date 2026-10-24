import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
type Kind='purchase'|'price'|'catalog'|'adjustment';
type Entry={id:string;kind:Kind;at:string;title:string;detail:string;actor:string};
const money=(c:number)=>`Q ${(c/100).toFixed(2)}`;
const catalogDetail=(action:string, raw:unknown):string=>{
 let value:unknown=raw;
 if(typeof value==='string') {try {value=JSON.parse(value)} catch {value=null}}
 const data=value && typeof value==='object' ? value as Record<string,unknown> : null;
 if(action==='set_variant_active'){
  if(data?.active===true || data?.active==='true')return 'Reactivado';
  if(data?.active===false || data?.active==='false')return 'Desactivado';
  return 'Estado actualizado';
 }
 if(action==='create_variant')return 'Presentación creada';
 if(action==='create_family')return 'Producto creado';
 if(action==='rename_variant')return 'Presentación renombrada';
 if(action==='rename_family')return 'Producto renombrado';
 return 'Catálogo actualizado';
};
const date=(s:string)=>new Date(s).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'short',timeStyle:'short'});
export function AdminHistoryPanel(){
 const [kind,setKind]=useState<'all'|Kind>('all');const [rows,setRows]=useState<Entry[]>([]);
 const [loading,setLoading]=useState(false),[error,setError]=useState('');
 async function load(){if(!supabase)return;setLoading(true);setError('');
 try{
  const [p,pr,c,m,v,f,sp,l]=await Promise.all([
   supabase.from('admin_purchase_events').select('id,variant_id,quantity,unit_cost_cents,actor_id,created_at').order('created_at',{ascending:false}).limit(80),
   supabase.from('admin_price_events').select('id,variant_id,old_price_cents,new_price_cents,actor_id,created_at').order('created_at',{ascending:false}).limit(80),
   supabase.from('admin_catalog_events').select('id,action,family_id,variant_id,old_value,new_value,actor_id,created_at').order('created_at',{ascending:false}).limit(80),
   supabase.from('inventory_movements').select('id,lot_id,qty_change,reason,actor_id,created_at').in('reason',['waste','count_difference','other']).order('created_at',{ascending:false}).limit(80),
   supabase.from('product_variants').select('id,name,family_id,base_unit'),
   supabase.from('product_families').select('id,name'),
   supabase.from('staff_profiles').select('user_id,display_name'),
   supabase.from('inventory_lots').select('id,variant_id')
  ]);
  const failed=[p,pr,c,m,v,f,sp,l].find(r=>r.error);if(failed?.error)throw failed.error;
  const variants=new Map((v.data||[]).map(x=>[x.id,x]));const families=new Map((f.data||[]).map(x=>[x.id,x.name]));
  const people=new Map((sp.data||[]).map(x=>[x.user_id,x.display_name]));const lots=new Map((l.data||[]).map(x=>[x.id,x.variant_id]));
  const name=(id:string|null)=>{const x=id?variants.get(id):undefined;return x?`${families.get(x.family_id)||'Producto'} · ${x.name}`:'Producto anterior';};
  const who=(id:string|null)=>id?people.get(id)||'Personal':'Sistema';
  const entries:Entry[]=[
   ...(p.data||[]).map(x=>({id:'p'+x.id,kind:'purchase' as const,at:x.created_at,title:`Compra · ${name(x.variant_id)}`,detail:`+${x.quantity} ${variants.get(x.variant_id)?.base_unit||''} · ${money(x.unit_cost_cents)}/${variants.get(x.variant_id)?.base_unit||'unidad'}`,actor:who(x.actor_id)})),
   ...(pr.data||[]).map(x=>({id:'r'+x.id,kind:'price' as const,at:x.created_at,title:`Precio · ${name(x.variant_id)}`,detail:`${money(x.old_price_cents)} → ${money(x.new_price_cents)}`,actor:who(x.actor_id)})),
   ...(c.data||[]).map(x=>({id:'c'+x.id,kind:'catalog' as const,at:x.created_at,title:`Catálogo · ${x.variant_id?name(x.variant_id):families.get(x.family_id)||'Familia'}`,detail:catalogDetail(x.action,x.new_value),actor:who(x.actor_id)})),
   ...(m.data||[]).map(x=>({id:'m'+x.id,kind:'adjustment' as const,at:x.created_at,title:`Ajuste · ${name(lots.get(x.lot_id)||null)}`,detail:`${x.qty_change} ${variants.get(lots.get(x.lot_id)||'')?.base_unit||''} · ${x.reason==='waste'?'Merma':x.reason==='count_difference'?'Diferencia de conteo':'Otro motivo'}`,actor:who(x.actor_id)}))
  ];setRows(entries.sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100));
 }catch(e){setError(e instanceof Error?e.message:'No se pudo cargar el historial.')}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[]);
 const shown=rows.filter(r=>kind==='all'||r.kind===kind);
 return <section className="admin-panel admin-history"><div className="admin-history-head"><h3>Historial administrativo</h3><button onClick={()=>void load()} disabled={loading}>{loading?'Cargando…':'Actualizar'}</button></div>
 <label>Ver movimientos<select value={kind} onChange={e=>setKind(e.target.value as typeof kind)}><option value="all">Todos</option><option value="purchase">Compras</option><option value="price">Precios</option><option value="catalog">Productos</option><option value="adjustment">Ajustes</option></select></label>
 {error&&<p role="alert" className="admin-error">{error}</p>}{!loading&&!error&&shown.length===0&&<p>No hay movimientos para este filtro.</p>}
 <div className="admin-history-list">{shown.map(x=><article className="admin-history-item" key={x.id}><div><strong>{x.title}</strong><p>{x.detail}</p><small>{x.actor} · {date(x.at)}</small></div></article>)}</div>
 <small>Solo lectura · Últimos movimientos disponibles. Los registros originales no se modifican.</small></section>;
}
