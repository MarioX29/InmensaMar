import {useEffect,useMemo,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';
type Transfer={id:string;reference:string;source:'counter'|'delivery';amount:number;created:string;customer?:string;verified:boolean};
const money=(n:number)=>`Q ${(n/100).toFixed(2)}`;
const dateKey=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const dateTime=(value:string)=>new Date(value).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'medium',timeStyle:'short'});
export function TransferVerificationPanel(){
 const [rows,setRows]=useState<Transfer[]>([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [sourceFilter,setSourceFilter]=useState<'all'|'counter'|'delivery'>('all'),[statusFilter,setStatusFilter]=useState<'pending'|'verified'|'all'>('pending');
 const [dateFrom,setDateFrom]=useState(''),[dateTo,setDateTo]=useState(''),[search,setSearch]=useState('');
 const running=useRef(false);
 async function load(){
  if(!supabase)return;
  setLoading(true);setError('');
  try{
   const [counter,delivery]=await Promise.all([
    supabase.from('sale_payments').select('id,sale_id,amount_cents,created_at,status').eq('method','transfer').in('status',['pending_verification','received']).order('created_at',{ascending:false}).limit(200),
    supabase.from('delivery_payment_events').select('id,order_id,amount_cents,created_at,event_kind,method,verified_at').eq('event_kind','payment').eq('method','transfer_reported').order('created_at',{ascending:false}).limit(200)
   ]);
   if(counter.error||delivery.error)throw counter.error||delivery.error;
   const orderIds=[...new Set((delivery.data||[]).map(x=>x.order_id))];
   const orders=orderIds.length?await supabase.from('customer_orders').select('id,customer_name').in('id',orderIds):{data:[],error:null};
   if(orders.error)throw orders.error;
   const names=new Map((orders.data||[]).map(x=>[x.id,x.customer_name]));
   setRows([
    ...(counter.data||[]).map(x=>({id:x.id,reference:x.sale_id,source:'counter' as const,amount:Number(x.amount_cents),created:x.created_at,verified:x.status==='received'})),
    ...(delivery.data||[]).map(x=>({id:x.id,reference:x.order_id,source:'delivery' as const,amount:Number(x.amount_cents),created:x.created_at,customer:names.get(x.order_id),verified:Boolean(x.verified_at)}))
   ].sort((a,b)=>b.created.localeCompare(a.created)));
  }catch{setError('No pudimos consultar las transferencias. Actualizá antes de verificar un pago.');setRows([])}finally{setLoading(false)}
 }
 useEffect(()=>{void load()},[]);
 const shown=useMemo(()=>rows.filter(row=>{
  const day=dateKey(row.created);
  return (sourceFilter==='all'||row.source===sourceFilter)&&(statusFilter==='all'||(statusFilter==='verified'?row.verified:!row.verified))&&(!dateFrom||day>=dateFrom)&&(!dateTo||day<=dateTo)&&(!search||`${row.reference} ${row.reference.slice(0,8)} ${row.customer||''}`.toLowerCase().includes(search.trim().toLowerCase()));
 }),[rows,sourceFilter,statusFilter,dateFrom,dateTo,search]);
 async function verify(row:Transfer){
  if(!supabase||running.current||loading||row.verified)return;
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
 return <section className="admin-history transfer-history">
  <header className="admin-history-head"><div><h3>Transferencias</h3><p className="admin-hint">Compará el abono con el movimiento bancario antes de marcarlo como verificado.</p></div><button disabled={busy||loading} onClick={()=>void load()}>Actualizar</button></header>
  <div className="transfer-filters">
   <label>Estado<select value={statusFilter} onChange={e=>setStatusFilter(e.target.value as typeof statusFilter)}><option value="pending">Por verificar</option><option value="verified">Verificadas</option><option value="all">Todas</option></select></label>
   <label>Origen<select value={sourceFilter} onChange={e=>setSourceFilter(e.target.value as typeof sourceFilter)}><option value="all">Todos</option><option value="counter">Mostrador</option><option value="delivery">Reparto</option></select></label>
   <label>Desde<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
   <label>Hasta<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
   <label className="transfer-search">Buscar<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Pedido, venta o cliente"/></label>
  </div>
  {notice&&<p role="status" className="admin-ok">{notice}</p>}{error&&<p role="alert" className="admin-error">{error}</p>}
  {loading?<p role="status">Cargando transferencias…</p>:!error&&!shown.length?<p>No hay transferencias para estos filtros.</p>:<>
   <p className="sales-result-count">{shown.length} transferencias en los registros cargados.</p>
   <div className="transfer-list">{shown.map(row=><article key={row.id} className="transfer-item">
    <div className="transfer-item-main"><div><strong>{row.customer|| (row.source==='counter'?'Venta de mostrador':'Pedido de reparto')}</strong><small>{row.source==='counter'?'Venta':'Pedido'} #{row.reference.slice(0,8)} · {dateTime(row.created)}</small></div><strong className="transfer-amount">{money(row.amount)}</strong></div>
    <div className="transfer-item-footer"><span className={`transfer-status ${row.verified?'is-verified':'is-pending'}`}>{row.verified?'Transferencia verificada':'Pendiente de verificación'}</span>{!row.verified&&<button disabled={busy} onClick={()=>void verify(row)}>Verifiqué el abono</button>}</div>
   </article>)}</div>
  </>}
  <small>Se cargan hasta 200 movimientos recientes por origen. La verificación confirma el abono; no registra un segundo cobro.</small>
 </section>;
}
