import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import {saveAdminAttempt,clearAdminAttempt} from './AdminPending';
import './finance.css';
type Expense={id:string;request_id:string;amount_cents:number;category:string;payment_source:string;note:string|null;expense_date:string;created_at:string;actor_id:string};
const categories:Record<string,string>={ice:'Hielo',packaging:'Bolsas y empaques',fuel:'Combustible',transport:'Transporte',utilities:'Servicios',other:'Otros'};
const sources:Record<string,string>={business_cash:'Efectivo del negocio',business_transfer:'Transferencia del negocio',personal:'Dinero personal',other:'Otro'};
const money=(c:number)=>'Q '+(c/100).toFixed(2);
export function FinanceExpensesPanel(){
 const [amount,setAmount]=useState('');const [category,setCategory]=useState('ice');const [source,setSource]=useState('business_cash');const [note,setNote]=useState('');
 const [date,setDate]=useState(()=>new Date().toLocaleDateString('en-CA'));
 const [rows,setRows]=useState<Expense[]>([]);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [notice,setNotice]=useState('');const [requestId,setRequestId]=useState(()=>crypto.randomUUID());
 async function load(){if(!supabase)return;const {data,error}=await supabase.from('operating_expenses').select('id,request_id,amount_cents,category,payment_source,note,expense_date,created_at,actor_id').order('created_at',{ascending:false}).limit(30);if(error)setError(error.message);else setRows((data||[]) as Expense[])}
 useEffect(()=>{void load()},[]);
 async function submit(){if(!supabase||busy)return;setError('');setNotice('');
  const cleaned=amount.trim().replace(',','.');const cents=Math.round(Number(cleaned)*100);
  if(!/^\d+(?:[.,]\d{1,2})?$/.test(amount.trim())||!Number.isSafeInteger(cents)||cents<=0){setError('Ingresá un monto válido mayor que cero.');return;}
  if(note.length>250){setError('La nota no puede superar 250 caracteres.');return;}
  if(!date){setError('Seleccioná una fecha.');return;}
  if(!window.confirm(`¿Registrar gasto de ${money(cents)} en ${categories[category]}?\nLos gastos pagados con efectivo del negocio descuentan Caja. No los registrés también como retiro.`))return;
  setBusy(true);
  try{
   const payload={p_request_id:requestId,p_amount_cents:cents,p_category:category,p_payment_source:source,p_note:note.trim()||null,p_expense_date:date};
   const attempt=await saveAdminAttempt('expense',payload,`Gasto ${categories[category]} · ${money(cents)}`);
   const {error:rpcError}=await supabase.rpc('admin_record_expense',payload);
   if(rpcError)throw rpcError;
   await clearAdminAttempt(attempt);setRequestId(crypto.randomUUID());setAmount('');setNote('');setNotice('Gasto registrado.');await load();
  }catch(e){const msg=e instanceof Error?e.message:'Error al registrar';setError(/load failed|failed to fetch|networkerror|fetch failed/i.test(msg)?'No pudimos confirmar el gasto. Verificá la operación pendiente antes de repetirla.':msg+' Verificá la operación pendiente antes de repetirla.');}
  finally{setBusy(false)}
 }
 return <section className="finance-panel"><div className="admin-form"><h3>Registrar gasto</h3><p className="admin-hint">No incluye compras de mercadería ni retiros personales. Las compras del negocio reportadas por repartidores se registran automáticamente al liquidar; no las ingresés de nuevo.</p>
 <label>Monto (Q)<input inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)} placeholder="Ej. 75.00" disabled={busy}/></label>
 <label>Categoría<select value={category} onChange={e=>setCategory(e.target.value)} disabled={busy}>{Object.entries(categories).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Pagado con<select value={source} onChange={e=>setSource(e.target.value)} disabled={busy}>{Object.entries(sources).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label>Fecha del gasto<input type="date" value={date} onChange={e=>setDate(e.target.value)} disabled={busy}/></label>
 <label>Nota (opcional)<input value={note} maxLength={250} onChange={e=>setNote(e.target.value)} placeholder="Detalle del gasto" disabled={busy}/></label>
 {error&&<p role="alert" className="admin-error">{error}</p>}{notice&&<p role="status" className="admin-ok">{notice}</p>}
 <button className="primary" onClick={()=>void submit()} disabled={busy}>{busy?'Guardando…':'Guardar gasto'}</button>
 <small>Los gastos en efectivo del negocio reducen el esperado de Caja de esa fecha. Las transferencias y el dinero personal no reducen el efectivo del cajón.</small></div>
 <div className="finance-history"><div className="finance-history-heading"><h3>Gastos recientes</h3><button onClick={()=>void load()} disabled={busy}>Actualizar</button></div>
 {rows.length===0?<p className="admin-hint">Todavía no hay gastos registrados.</p>:rows.map(r=><div className="finance-entry" key={r.id}><div><strong>{categories[r.category]||r.category}</strong><small>{r.expense_date} · {sources[r.payment_source]||r.payment_source}</small>{r.note&&<small>{r.note}</small>}</div><b>{money(Number(r.amount_cents))}</b></div>)}
 </div></section>
}
