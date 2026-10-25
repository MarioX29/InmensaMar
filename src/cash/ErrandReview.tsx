import {useCallback,useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
type Errand={id:string;description:string;amount_cents:number;category:'personal'|'business';status:string;driver_id:string;created_at:string};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const msg=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo completar.';
export function ErrandReview(){
 const [rows,setRows]=useState<Errand[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState<string|null>(null);
 const load=useCallback(async()=>{if(!supabase)return;const {data,error:e}=await supabase.from('driver_cash_errands').select('id,description,amount_cents,category,status,driver_id,created_at').order('created_at',{ascending:false}).limit(100);if(e){setError(msg(e));return;}setRows((data||[]) as Errand[]);setError('');},[]);
 useEffect(()=>{void load();},[load]);
 async function review(row:Errand,approve:boolean){if(!supabase||busy)return;if(!window.confirm(`${approve?'Aprobar':'Rechazar'} ${row.description} por ${money(row.amount_cents)}?`))return;setBusy(row.id);setError('');setNotice('');try{const {error:e}=await supabase.rpc('review_driver_cash_errand',{p_errand_id:row.id,p_approve:approve});if(e){setError(msg(e));return;}setNotice('Revisión registrada.');await load();}catch(e){setError(msg(e));}finally{setBusy(null);}}
 return <section className="cash-card"><h3>Compras de repartidores</h3><p>Revisá las compras reportadas. La aprobación todavía no modifica automáticamente Caja ni Finanzas.</p><button type="button" disabled={!!busy} onClick={()=>void load()}>Actualizar</button>
 {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
 {!rows.length?<p>Sin compras registradas.</p>:<div className="cash-table-wrap"><table><thead><tr><th>Compra</th><th>Tipo</th><th>Monto</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.description}</td><td>{r.category==='personal'?'Personal':'Negocio'}</td><td>{money(r.amount_cents)}</td><td>{r.status}</td><td>{r.status==='reported'?<><button type="button" disabled={!!busy} onClick={()=>void review(r,true)}>Aprobar</button> <button type="button" disabled={!!busy} onClick={()=>void review(r,false)}>Rechazar</button></>:'—'}</td></tr>)}</tbody></table></div>}
 </section>;
}
