import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
type Sale={id:string;created_at:string;total_cents:number;status:string};
const money=(c:number)=>`Q ${(Number(c)/100).toFixed(2)}`;
export function SalesHistoryPanel(){
 const [rows,setRows]=useState<Sale[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function load(){if(!supabase)return;setBusy(true);setError('');try{const result=await supabase.from('sales').select('id,created_at,total_cents,status').order('created_at',{ascending:false}).limit(100);if(result.error)throw result.error;setRows(result.data||[])}catch(e){setError(e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo consultar las ventas.')}finally{setBusy(false)}}
 useEffect(()=>{void load()},[]);
 return <section className="admin-history"><header className="admin-history-head"><div><h3>Ventas de mostrador</h3><p className="admin-hint">Últimas 100 ventas. Los pedidos de reparto se consultan en Pedidos.</p></div><button disabled={busy} onClick={()=>void load()}>Actualizar</button></header>{error&&<p role="alert" className="admin-error">{error}</p>}{busy?<p role="status">Cargando ventas…</p>:!error&&rows.length===0?<p>No hay ventas registradas.</p>:<div className="admin-history-list">{rows.map(s=><article className="admin-history-item" key={s.id}><div><strong>{money(s.total_cents)} · {s.status==='completed'?'Completada':s.status==='voided'?'Anulada':s.status}</strong><p>{new Date(s.created_at).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'short',timeStyle:'short'})}</p><small>Venta #{s.id.slice(0,8)}</small></div></article>)}</div>}</section>;
}
