import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import {saveAdminAttempt,clearAdminAttempt} from './AdminPending';
import './owner-dashboard.css';
type Variant={id:string;name:string;base_unit:string;minimum_stock:number;active:boolean};
export function StockMinimumPanel(){
 const [items,setItems]=useState<Variant[]>([]);const [id,setId]=useState('');const [value,setValue]=useState('0');const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');
 async function load(){if(!supabase)return;const {data,error:e}=await supabase.from('product_variants').select('id,name,base_unit,minimum_stock,active').order('name');if(e){setError(e.message);return}setItems((data||[]) as Variant[])}
 useEffect(()=>{void load()},[]);
 function choose(next:string){setId(next);const p=items.find(x=>x.id===next);setValue(String(p?.minimum_stock??0));setError('');setNotice('')}
 async function save(){if(!supabase||busy||!id)return;setError('');setNotice('');const n=Number(value.replace(',','.'));if(!Number.isFinite(n)||n<0||n>100000||Math.round(n*10000)!==n*10000){setError('Ingresá un mínimo válido, hasta cuatro decimales.');return}
 if(!window.confirm('¿Guardar el stock mínimo de esta presentación?'))return;
 setBusy(true);try{const payload={p_request_id:crypto.randomUUID(),p_variant_id:id,p_minimum:n};const attempt=await saveAdminAttempt('minimum',payload,`Stock mínimo: ${items.find(x=>x.id===id)?.name||id}`);const {error:e}=await supabase.rpc('admin_set_stock_minimum',payload);if(e)throw e;await clearAdminAttempt(attempt);setNotice('Stock mínimo guardado.');await load()}catch(e){setError((e instanceof Error?e.message:'No se pudo confirmar')+'. Si quedó pendiente, salí y regresá a Administración para verificarlo.')}finally{setBusy(false)}}
 return <section className="owner-section"><h3>Stock mínimo por presentación</h3><p className="owner-muted">Un mínimo de 0 desactiva la alerta para esa presentación.</p><label>Presentación<select value={id} onChange={e=>choose(e.target.value)} disabled={busy}><option value="">Seleccionar</option>{items.map(x=><option key={x.id} value={x.id}>{x.name} · {x.base_unit}{x.active?'':' (inactiva)'}</option>)}</select></label><label>Mínimo<input inputMode="decimal" value={value} onChange={e=>setValue(e.target.value)} disabled={busy||!id}/></label><button className="primary" onClick={()=>void save()} disabled={busy||!id}>{busy?'Guardando…':'Guardar mínimo'}</button>{error&&<p role="alert" className="admin-error">{error}</p>}{notice&&<p role="status" className="admin-ok">{notice}</p>}</section>
}
