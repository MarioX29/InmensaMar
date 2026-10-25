import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import './delivery-returns.css';

type ReturnRow={order_id:string;customer_name:string;movement_id:string;lot_id:string;quantity:number;product_name:string};
const getError=(e:unknown)=>e&&typeof e==='object'&&'message' in e?String(e.message):'Error desconocido';
export function DeliveryReturnsPanel(){
 const [rows,setRows]=useState<ReturnRow[]>([]);
 const [values,setValues]=useState<Record<string,string>>({});
 const [pending,setPending]=useState<{requestId:string;orderId:string;lines:{movement_id:string;good:number;damaged:number}[]}|null>(()=>{try{return JSON.parse(localStorage.getItem('im-return-pending')||'null');}catch{return null;}});
 const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');
 const refresh=useCallback(async()=>{if(!supabase)return;const {data,error}=await supabase.rpc('pending_delivery_returns');if(error)setMessage(getError(error));else setRows((data||[]) as ReturnRow[]);},[]);
 useEffect(()=>{void refresh();},[refresh]);
 const groups=Object.values(rows.reduce<Record<string,ReturnRow[]>>((acc,r)=>{(acc[r.order_id]??=[]).push(r);return acc;},{}));
 async function confirm(orderId:string){
  if(!supabase||busy)return;
  const lines=rows.filter(x=>x.order_id===orderId).map(x=>({movement_id:x.movement_id,good:Number(values[x.movement_id]??x.quantity),damaged:Math.round((x.quantity-Number(values[x.movement_id]??x.quantity))*10000)/10000}));
  if(lines.some(x=>!Number.isFinite(x.good)||x.good<0||x.damaged<0||Math.round(x.good*10000)!==x.good*10000)){setMessage('Revisá las cantidades recuperadas.');return;}
  const attempt=pending||{requestId:crypto.randomUUID(),orderId,lines};
  if(pending&&pending.orderId!==orderId){setMessage('Primero verificá la devolución pendiente.');return;}
  if(!pending){localStorage.setItem('im-return-pending',JSON.stringify(attempt));setPending(attempt);}
  setBusy(true);setMessage('');
  try{const {error}=await supabase.rpc('confirm_delivery_return',{p_order_id:attempt.orderId,p_request_id:attempt.requestId,p_lines:attempt.lines});if(error){setMessage(`${getError(error)}. Verificá antes de repetir.`);return;}localStorage.removeItem('im-return-pending');setPending(null);setMessage('Devolución confirmada.');await refresh();}
  catch(e){setMessage(`${getError(e)}. No iniciés otra devolución.`);}finally{setBusy(false);}
 }
 return <section className="delivery-card"><div className="delivery-card-head"><h2>Devoluciones pendientes</h2><button disabled={busy} onClick={()=>void refresh()}>Actualizar</button></div>
 <p className="delivery-subtitle">Confirmá físicamente cuánto regresó en buen estado. La diferencia se registra como pérdida. No recibás mercadería que todavía no haya llegado.</p>
 {message&&<p role="status">{message}</p>}
 {!groups.length?<p>No hay devoluciones pendientes.</p>:groups.map(group=><div className="delivery-route" key={group[0].order_id}><strong>{group[0].customer_name} · #{group[0].order_id.slice(0,8)}</strong>
 {group.map(line=><label key={line.movement_id} className="delivery-return-line"><span>{line.product_name} · Despachado: {line.quantity}</span><span>En buen estado</span><input type="number" min="0" max={line.quantity} step="0.0001" value={values[line.movement_id]??String(line.quantity)} disabled={busy||!!pending} onChange={e=>setValues(v=>({...v,[line.movement_id]:e.target.value}))}/></label>)}
 <button className="delivery-primary" disabled={busy||!!pending&&pending.orderId!==group[0].order_id} onClick={()=>void confirm(group[0].order_id)}>{pending?.orderId===group[0].order_id?'Verificar misma devolución':'Confirmar recepción'}</button></div>)}
 </section>;
}
