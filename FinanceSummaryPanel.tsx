import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import './finance-summary.css';
type Summary={counter_sales_cents:number;delivery_sales_cents:number;counter_cogs_cents:number;delivery_cogs_cents:number;waste_cost_cents:number;expenses_cents:number;counter_cash_received_cents:number;delivery_cash_received_cents:number;delivery_transfer_verified_cents:number;delivery_transfer_reported_unverified_cents:number;delivered_without_payment_cents:number};
type Period='today'|'week'|'month';
const money=(c:number)=>new Intl.NumberFormat('es-GT',{style:'currency',currency:'GTQ'}).format(c/100);
function gtDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
function dates(period:Period){const today=gtDate();const d=new Date(today+'T12:00:00Z');if(period==='week'){const day=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-day)}if(period==='month')d.setUTCDate(1);return {from:d.toISOString().slice(0,10),to:today}}
export function FinanceSummaryPanel(){
 const [period,setPeriod]=useState<Period>('today');const [data,setData]=useState<Summary|null>(null);const [loading,setLoading]=useState(false);const [error,setError]=useState('');
 async function load(p:Period){if(!supabase)return;setLoading(true);setError('');const range=dates(p);try{const {data:rows,error:rpcError}=await supabase.rpc('finance_period_summary',{p_from:range.from,p_to:range.to});if(rpcError)throw rpcError;setData((Array.isArray(rows)?rows[0]:rows) as Summary||null)}catch(e){setError(e instanceof Error?e.message:'No se pudo cargar el resumen');setData(null)}finally{setLoading(false)}}
 useEffect(()=>{void load(period)},[period]);
 const n=(key:keyof Summary)=>Number(data?.[key]||0);
 const sales=n('counter_sales_cents')+n('delivery_sales_cents');
 const cogs=n('counter_cogs_cents')+n('delivery_cogs_cents');
 const gross=sales-cogs;const result=gross-n('waste_cost_cents')-n('expenses_cents');
 const received=n('counter_cash_received_cents')+n('delivery_cash_received_cents')+n('delivery_transfer_verified_cents');
 return <section className="finance-summary"><div className="finance-summary-head"><div><h3>Resumen financiero</h3><p>Resultados estimados del negocio · Guatemala</p></div><button onClick={()=>void load(period)} disabled={loading}>Actualizar</button></div>
 <div className="finance-period">{([['today','Hoy'],['week','Semana'],['month','Mes']] as const).map(([value,label])=><button key={value} className={period===value?'selected':''} onClick={()=>setPeriod(value)}>{label}</button>)}</div>
 {loading&&<p role="status">Cargando datos…</p>}{error&&<p role="alert" className="admin-error">{error}</p>}
 {!loading&&data&&<><div className="finance-metrics"><div><small>Ventas</small><strong>{money(sales)}</strong></div><div><small>Resultado estimado</small><strong>{money(result)}</strong></div><div><small>Costo de ventas</small><strong>{money(cogs)}</strong></div><div><small>Dinero confirmado en el período</small><strong>{money(received)}</strong></div></div>
 <details className="work-disclosure"><summary><strong>Detalle del resultado</strong><span>Ventas, costos y gastos →</span></summary><div className="finance-breakdown"><div><span>Mostrador</span><b>{money(n('counter_sales_cents'))}</b></div><div><span>Entregas</span><b>{money(n('delivery_sales_cents'))}</b></div><div><span>Margen bruto</span><b>{money(gross)}</b></div><div><span>Mermas</span><b>−{money(n('waste_cost_cents'))}</b></div><div><span>Gastos</span><b>−{money(n('expenses_cents'))}</b></div><div className="finance-total"><span>Resultado operativo estimado</span><b>{money(result)}</b></div></div></details>
 <details className="work-disclosure"><summary><strong>Cobros y pendientes</strong><span>Ver efectivo y transferencias →</span></summary><div className="finance-breakdown"><div><span>Efectivo recibido en el período</span><b>{money(n('counter_cash_received_cents')+n('delivery_cash_received_cents'))}</b></div><div><span>Transferencias verificadas en el período</span><b>{money(n('delivery_transfer_verified_cents'))}</b></div><div><span>Transferencias reportadas sin verificar (pedidos entregados del período)</span><b>{money(n('delivery_transfer_reported_unverified_cents'))}</b></div><div><span>Pedidos entregados sin pago reportado</span><b>{money(n('delivered_without_payment_cents'))}</b></div></div></details>
 <details className="feature-note"><summary>Cómo interpretar estos resultados</summary><p className="finance-disclaimer">Resultados preliminares: las ventas se asignan por fecha de creación (mostrador) o entrega (reparto); los cobros por fecha de pago/verificación. Los pendientes se refieren a pedidos entregados en el período. No incluye devoluciones no resueltas, impuestos ni todos los costos del negocio. No equivale a saldo de Caja ni utilidad neta.</p></details></>}
 </section>
}
