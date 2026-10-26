import {businessDate} from '../ui/dates';
import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import './owner-dashboard.css';
type Period='today'|'week'|'month';
type Product={id:string;family:string;name:string;unit:string;quantity:number;revenue_cents:number;cost_cents:number;margin_cents:number};
type Critical={id:string;family:string;name:string;unit:string;minimum:number;available:number};
type Daily={date:string;operations:number;sales_cents:number};
type Dashboard={sales_cents:number;previous_sales_cents:number;daily:Daily[];products:Product[];critical:Critical[]};
function readDashboard(value:unknown):Dashboard{
 if(!value||typeof value!=='object')throw new Error('El resumen del negocio no está disponible. Volvé a cargarlo.');
 const result=value as Record<string,unknown>;
 if(!Array.isArray(result.daily)||!Array.isArray(result.products)||!Array.isArray(result.critical)
   ||result.daily.some(row=>!row||typeof row!=='object')
   ||result.products.some(row=>!row||typeof row!=='object')
   ||result.critical.some(row=>!row||typeof row!=='object')){
  throw new Error('El resumen llegó incompleto. Volvé a cargarlo.');
 }
 return value as Dashboard;
}
const money=(c:number)=>new Intl.NumberFormat('es-GT',{style:'currency',currency:'GTQ'}).format(Number(c)/100);
const qty=(n:number)=>Number(n).toLocaleString('es-GT',{maximumFractionDigits:4});
function range(period:Period){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Guatemala',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const d=new Date(parts+'T12:00:00Z');if(period==='week')d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);if(period==='month')d.setUTCDate(1);return {from:d.toISOString().slice(0,10),to:parts}}
export function OwnerDashboardPanel(){
 const [period,setPeriod]=useState<Period>('week');const [data,setData]=useState<Dashboard|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 async function load(){if(!supabase)return;setBusy(true);setError('');try{const r=range(period);const {data:result,error:e}=await supabase.rpc('owner_growth_dashboard',{p_from:r.from,p_to:r.to});if(e)throw e;setData(readDashboard(result))}catch(e){setError(e instanceof Error?e.message:'No se pudo cargar el panel');setData(null)}finally{setBusy(false)}}
 useEffect(()=>{void load()},[period]);
 const products=data?.products||[];const topMargin=[...products].sort((a,b)=>Number(b.margin_cents)-Number(a.margin_cents));
 const change=data&&Number(data.previous_sales_cents)>0?(Number(data.sales_cents)-Number(data.previous_sales_cents))/Number(data.previous_sales_cents)*100:null;
 const max=Math.max(1,...(data?.daily||[]).map(x=>Number(x.sales_cents)));
 return <section className="owner-dashboard"><header className="owner-dashboard-header"><div><h2>Mi negocio</h2><p>Ventas, productos e inventario</p></div><button onClick={()=>void load()} disabled={busy}>Actualizar</button></header>
 <div className="owner-period">{([['today','Hoy'],['week','Semana'],['month','Mes']] as const).map(([p,label])=><button key={p} className={period===p?'selected':''} onClick={()=>setPeriod(p)}>{label}</button>)}</div>
 {busy&&<p role="status">Cargando…</p>}{error&&<p role="alert" className="admin-error">{error}</p>}
 {!busy&&data&&<><div className="owner-kpis"><div><small>Ventas del período</small><strong>{money(data.sales_cents)}</strong></div><div><small>Período anterior</small><strong>{money(data.previous_sales_cents)}</strong></div><div><small>Variación de ventas</small><strong>{change===null?'Sin base anterior':`${change>=0?'+':''}${change.toFixed(1)}%`}</strong></div><div><small>Productos con inventario bajo</small><strong>{data.critical.length}</strong></div></div>
 <article className="owner-section"><h3>Ventas por día</h3><div className="owner-bars">{data.daily.map(d=><div key={d.date} className="owner-bar-row"><span>{businessDate(d.date,{year:false})}</span><div className="owner-bar-track"><div style={{width:`${Math.max(0,Number(d.sales_cents))/max*100}%`}}/></div><b>{money(d.sales_cents)}</b></div>)}</div></article>
 <article className="owner-section"><h3>Más vendidos por ingresos</h3>{products.length===0?<p>Sin ventas en este período.</p>:products.slice(0,8).map(p=><div className="owner-item" key={p.id}><span>{p.family} · {p.name}<small>{qty(p.quantity)} {p.unit}</small></span><b>{money(p.revenue_cents)}</b></div>)}</article>
 <details className="work-disclosure"><summary><strong>Rentabilidad por producto</strong><span>Comparar márgenes →</span></summary><article className="owner-section">{topMargin.length===0?<p>Sin datos en este período.</p>:topMargin.slice(0,8).map(p=><div className="owner-item" key={p.id}><span>{p.name}<small>Ingresos {money(p.revenue_cents)} · Costo {money(p.cost_cents)}</small></span><b className={Number(p.margin_cents)<0?'owner-negative':''}>{money(p.margin_cents)}</b></div>)}</article></details>
 <article className="owner-section"><h3>Inventario crítico</h3><p className="owner-muted">Solo presentaciones con mínimo configurado. Disponible = lotes vendibles menos reservas.</p>{data.critical.length===0?<p>No hay productos por debajo de mínimos configurados.</p>:data.critical.map(p=><div className="owner-item" key={p.id}><span>{p.family} · {p.name}</span><b>{qty(p.available)} / {qty(p.minimum)} {p.unit}</b></div>)}</article>
 <p className="owner-muted">Datos de QA. Comparación contra un período anterior de igual duración. Los ingresos incluyen pedidos entregados aunque el cobro no esté confirmado; consultá Finanzas para ganancias y cobros. No suma cantidades de unidades diferentes.</p></>}
 </section>
}
