import {useEffect,useMemo,useState} from 'react';
import {supabase} from '../lib/supabase';
import {unitLabels} from '../lib/units';
type Sale={id:string;created_at:string;total_cents:number;status:string};
type SaleLine={id:string;sale_id:string;variant_id:string;quantity:number;unit_price_cents:number;line_total_cents:number};
type Variant={id:string;name:string;family_id:string;base_unit:string};
type Family={id:string;name:string};
type Payment={sale_id:string;method:string;status:string;amount_cents:number};
const money=(c:number)=>`Q ${(Number(c)/100).toFixed(2)}`;
const dateKey=(value:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const dateTime=(value:string)=>new Date(value).toLocaleString('es-GT',{timeZone:'America/Guatemala',dateStyle:'medium',timeStyle:'short'});
const quantity=(value:number)=>Number(value).toLocaleString('es-GT',{maximumFractionDigits:4});
const statusLabel=(value:string)=>value==='completed'?'Completada':value==='voided'?'Anulada':value;
const paymentLabel=(payment:Payment)=>payment.method==='cash'?'Efectivo':payment.method==='transfer'?(payment.status==='received'?'Transferencia verificada':'Transferencia por verificar'):payment.method;
export function SalesHistoryPanel(){
 const [rows,setRows]=useState<Sale[]>([]),[lines,setLines]=useState<SaleLine[]>([]),[variants,setVariants]=useState<Record<string,Variant>>({}),[families,setFamilies]=useState<Record<string,string>>({}),[payments,setPayments]=useState<Payment[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[expanded,setExpanded]=useState<string|null>(null);
 const [dateFrom,setDateFrom]=useState(''),[dateTo,setDateTo]=useState(''),[status,setStatus]=useState<'all'|'completed'|'voided'>('all'),[search,setSearch]=useState('');
 async function load(){
  if(!supabase)return;
  setBusy(true);setError('');
  try{
   const result=await supabase.from('sales').select('id,created_at,total_cents,status').order('created_at',{ascending:false}).limit(100);
   if(result.error)throw result.error;
   const sales=(result.data||[]) as Sale[];setRows(sales);
   const ids=sales.map(s=>s.id);
   if(!ids.length){setLines([]);setVariants({});setFamilies({});setPayments([]);return;}
   const [lineResult,paymentResult]=await Promise.all([
    supabase.from('sale_lines').select('id,sale_id,variant_id,quantity,unit_price_cents,line_total_cents').in('sale_id',ids),
    supabase.from('sale_payments').select('sale_id,method,status,amount_cents').in('sale_id',ids)
   ]);
   if(lineResult.error||paymentResult.error)throw lineResult.error||paymentResult.error;
   const saleLines=(lineResult.data||[]) as SaleLine[];setLines(saleLines);setPayments((paymentResult.data||[]) as Payment[]);
   const variantIds=[...new Set(saleLines.map(line=>line.variant_id))];
   if(!variantIds.length){setVariants({});setFamilies({});return;}
   const variantResult=await supabase.from('product_variants').select('id,name,family_id,base_unit').in('id',variantIds);
   if(variantResult.error)throw variantResult.error;
   const loadedVariants=(variantResult.data||[]) as Variant[];setVariants(Object.fromEntries(loadedVariants.map(v=>[v.id,v])));
   const familyIds=[...new Set(loadedVariants.map(v=>v.family_id))];
   if(!familyIds.length){setFamilies({});return;}
   const familyResult=await supabase.from('product_families').select('id,name').in('id',familyIds);
   if(familyResult.error)throw familyResult.error;
   setFamilies(Object.fromEntries(((familyResult.data||[]) as Family[]).map(f=>[f.id,f.name])));
  }catch(e){setError(e&&typeof e==='object'&&'message' in e?String(e.message):'No se pudo consultar el detalle de ventas.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load()},[]);
 const shown=useMemo(()=>rows.filter(s=>{
  const day=dateKey(s.created_at);
  return (!dateFrom||day>=dateFrom)&&(!dateTo||day<=dateTo)&&(status==='all'||s.status===status)&&(!search||`${s.id} ${s.id.slice(0,8)}`.toLowerCase().includes(search.trim().toLowerCase()));
 }),[rows,dateFrom,dateTo,status,search]);
 return <section className="admin-history sales-history">
  <header className="admin-history-head"><div><h3>Ventas de mostrador</h3><p className="admin-hint">Últimas 100 ventas. Los pedidos de reparto se consultan en Pedidos.</p></div><button disabled={busy} onClick={()=>void load()}>{busy?'Cargando…':'Actualizar'}</button></header>
  <details className="sales-filter-disclosure"><summary>Filtrar ventas</summary><div className="sales-filters">
   <label>Desde<input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/></label>
   <label>Hasta<input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)}/></label>
   <label>Estado<select value={status} onChange={e=>setStatus(e.target.value as typeof status)}><option value="all">Todos</option><option value="completed">Completadas</option><option value="voided">Anuladas</option></select></label>
   <label>Buscar venta<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Número de venta"/></label>
  </div></details>
  {error&&<p role="alert" className="admin-error">{error}</p>}
  {!busy&&!error&&shown.length===0&&<p className="admin-hint">No hay ventas para estos filtros.</p>}
  <p className="sales-result-count">{shown.length} ventas en los registros cargados.</p>
  <div className="admin-history-list">{shown.map(s=>{
   const open=expanded===s.id;const saleLines=lines.filter(line=>line.sale_id===s.id);const salePayments=payments.filter(payment=>payment.sale_id===s.id);
   return <details className="admin-history-item sales-history-item" key={s.id} open={open} onToggle={e=>{if((e.currentTarget as HTMLDetailsElement).open)setExpanded(s.id);else if(expanded===s.id)setExpanded(null)}}>
    <summary><span><strong>{money(s.total_cents)} · {statusLabel(s.status)}</strong><small>{dateTime(s.created_at)}</small><small>Venta #{s.id.slice(0,8)} · {saleLines.length} {saleLines.length===1?'producto':'productos'}</small></span><span className="sales-disclosure-icon" aria-hidden="true">{open?'−':'+'}</span></summary>
    <div className="sales-detail-body">
     {saleLines.length===0?<p className="admin-hint">No se encontraron líneas para esta venta.</p>:saleLines.map(line=>{const variant=variants[line.variant_id];const unit=variant?unitLabels[variant.base_unit as keyof typeof unitLabels]||variant.base_unit:'unidad';return <div className="sales-detail-line" key={line.id}><span><strong>{variant?`${families[variant.family_id]||'Producto'} · ${variant.name}`:'Producto'}</strong><small>{quantity(Number(line.quantity))} {unit} × {money(line.unit_price_cents)}</small></span><b>{money(line.line_total_cents)}</b></div>})}
     <div className="sales-detail-total"><span>Total</span><strong>{money(s.total_cents)}</strong></div>
     <div className="sales-payment-detail"><strong>Pagos registrados</strong>{salePayments.length?salePayments.map((payment,index)=><div key={`${payment.sale_id}-${payment.method}-${index}`}><span>{paymentLabel(payment)}</span><b>{money(payment.amount_cents)}</b></div>):<small>Sin pagos registrados.</small>}</div>
    </div>
   </details>;
  })}</div>
 </section>;
}
