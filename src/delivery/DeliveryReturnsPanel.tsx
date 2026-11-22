import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { calculateReturnAmounts } from './deliveryPresentation.js';
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
  const group=rows.filter(x=>x.order_id===orderId);
  if(pending&&pending.orderId!==orderId){setMessage('Primero verificá la devolución pendiente.');return;}
  let lines:{movement_id:string;good:number;damaged:number}[];
  if(pending){
   // Retry the exact persisted request after an uncertain response or page reload.
   lines=pending.lines;
  }else{
   if(group.some(line=>values[line.movement_id]===undefined||values[line.movement_id].trim()==='')){setMessage('Ingresá cuánto recibiste en buen estado para cada producto.');return;}
   try{lines=group.map(line=>({movement_id:line.movement_id,...calculateReturnAmounts(line.quantity,Number(values[line.movement_id]))}));}
   catch(e){setMessage(getError(e));return;}
  }
  const attempt=pending||{requestId:crypto.randomUUID(),orderId,lines};
  if(!pending){localStorage.setItem('im-return-pending',JSON.stringify(attempt));setPending(attempt);}
  setBusy(true);setMessage('');
  try{const {error}=await supabase.rpc('confirm_delivery_return',{p_order_id:attempt.orderId,p_request_id:attempt.requestId,p_lines:attempt.lines});if(error){setMessage(`${getError(error)}. Verificá antes de repetir.`);return;}localStorage.removeItem('im-return-pending');setPending(null);setValues(v=>{const next={...v};group.forEach(line=>delete next[line.movement_id]);return next;});setMessage('Devolución confirmada. La cantidad en buen estado volvió al inventario y la diferencia quedó registrada como pérdida.');await refresh();}
  catch(e){setMessage(`${getError(e)}. No iniciés otra devolución.`);}finally{setBusy(false);}
 }
 return <section className="delivery-returns-workspace"><div className="delivery-section-heading"><h2>Devoluciones pendientes</h2><button type="button" disabled={busy} onClick={()=>void refresh()}>Actualizar</button></div>
 <p className="delivery-subtitle">Contá físicamente lo que regresó en buen estado. La diferencia se registra como pérdida; no confirmés mercadería que todavía no llegó al local.</p>
 {message&&<p role="status" className="delivery-return-message">{message}</p>}
 {!groups.length?<div className="delivery-empty">No hay devoluciones pendientes.</div>:<div className="delivery-return-grid">{groups.map(group=>{
  const orderId=group[0].order_id;
  const allEntered=pending?.orderId===orderId||group.every(line=>values[line.movement_id]!==undefined&&values[line.movement_id].trim()!=='');
  return <article className="delivery-return-card" key={orderId}>
   <div className="delivery-return-card-head"><div><strong>{group[0].customer_name}</strong><small>Pedido #{orderId.slice(0,8)} · {group.length} {group.length===1?'producto':'productos'}</small></div></div>
   {group.map(line=>{
    const raw=values[line.movement_id]??'';
    const good=raw.trim()===''?null:Number(raw);
    const damaged=good!==null&&Number.isFinite(good)&&good>=0&&good<=line.quantity?Math.round((line.quantity-good)*10000)/10000:null;
    return <div className="delivery-return-product" key={line.movement_id}>
     <div className="delivery-return-product-copy"><strong>{line.product_name}</strong><small>Despachado: {line.quantity}</small></div>
     <label className="delivery-return-quantity">En buen estado<input type="number" min="0" max={line.quantity} step="0.0001" placeholder="Cantidad recibida" value={raw} disabled={busy||!!pending} onChange={e=>setValues(v=>({...v,[line.movement_id]:e.target.value}))}/></label>
     <div className="delivery-return-loss"><span>Diferencia registrada como pérdida</span><strong>{damaged===null?'—':damaged}</strong></div>
    </div>;
   })}
   <button className="delivery-primary" disabled={busy||!!pending&&pending.orderId!==orderId||!allEntered} onClick={()=>void confirm(orderId)}>{pending?.orderId===orderId?'Verificar misma devolución':'Confirmar recepción física'}</button>
   {pending?.orderId===orderId&&<small role="alert">Hay una devolución por verificar. Se conservaron los mismos datos para evitar duplicados.</small>}
  </article>;
 })}</div>}
 </section>;
}
