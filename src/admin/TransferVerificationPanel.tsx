import {useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
type Transfer={id:string;reference:string;source:'counter'|'delivery';amount:number;created:string;customer?:string};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
export function TransferVerificationPanel(){
 const [rows,setRows]=useState<Transfer[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const running=useRef(false);
 async function load(){
  if(!supabase)return;
  setLoading(true);setError('');
  try{
   const [counter,delivery]=await Promise.all([
    supabase.from('sale_payments').select('id,sale_id,amount_cents,created_at').eq('method','transfer').eq('status','pending_verification').order('created_at',{ascending:true}).limit(100),
    supabase.from('delivery_payment_events').select('id,order_id,amount_cents,created_at').eq('event_kind','payment').eq('method','transfer_reported').is('verified_at',null).order('created_at',{ascending:true}).limit(100)
   ]);
   if(counter.error||delivery.error)throw counter.error||delivery.error;
   const orders=delivery.data?.length?await supabase.from('customer_orders').select('id,customer_name').in('id',delivery.data.map(x=>x.order_id)):{data:[],error:null};
   if(orders.error)throw orders.error;
   const names=new Map((orders.data||[]).map(x=>[x.id,x.customer_name]));
   setRows([
    ...(counter.data||[]).map(x=>({id:x.id,reference:x.sale_id,source:'counter' as const,amount:Number(x.amount_cents),created:x.created_at})),
    ...(delivery.data||[]).map(x=>({id:x.id,reference:x.order_id,source:'delivery' as const,amount:Number(x.amount_cents),created:x.created_at,customer:names.get(x.order_id)}))
   ].sort((a,b)=>a.created.localeCompare(b.created)));
  }catch{setError('No pudimos consultar las transferencias. Actualizá antes de verificar un pago.');setRows([])}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[]);
 async function verify(row:Transfer){
  if(!supabase||running.current||loading)return;
  if(!window.confirm(`¿Confirmás que revisaste en el banco esta transferencia de ${money(row.amount)}?`))return;
  running.current=true;setBusy(true);setError('');setNotice('');
  try{
   const result=row.source==='counter'
    ?await supabase.rpc('verify_transfer_payment',{p_payment_id:row.id})
    :await supabase.rpc('verify_delivery_transfer',{p_order_id:row.reference});
   if(result.error)throw result.error;
   setNotice('Transferencia verificada.');await load();
  }catch{setError('No pudimos confirmar la verificación. Actualizá la lista para comprobar si ya quedó registrada.')}finally{running.current=false;setBusy(false)}
 }
 return <section className="admin-history"><header className="admin-history-head"><div><h3>Transferencias por verificar</h3><p className="admin-hint">Revisá el abono en el banco antes de confirmar. Hasta 100 pendientes de mostrador y 100 de reparto, comenzando por los más antiguos.</p></div><button disabled={busy||loading} onClick={()=>void load()}>Actualizar</button></header>
  {notice&&<p role="status" className="admin-ok">{notice}</p>}{error&&<p role="alert" className="admin-error">{error}</p>}
  {loading?<p role="status">Cargando transferencias…</p>:!error&&!rows.length?<p>No hay transferencias pendientes.</p>:rows.map(row=><article key={row.id} className="admin-history-item"><div><strong>{money(row.amount)} · {row.customer||(row.source==='counter'?'Mostrador':'Reparto')}</strong><p>{new Date(row.created).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'short',timeStyle:'short'})}</p><small>{row.source==='counter'?'Venta':'Pedido'} #{row.reference}</small></div><button disabled={busy} onClick={()=>void verify(row)}>Verifiqué el abono</button></article>)}
 </section>;
}
