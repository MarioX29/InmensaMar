import {SalesHistoryPanel} from './SalesHistoryPanel';
import {AdminSectionBoundary} from './AdminSectionBoundary';
import {useEffect,useState} from 'react';
import {AdminAttempt,getAdminAttempt,verifyAdminAttempt,clearAdminAttempt} from './AdminPending';
import {AdminOperationsPanel} from './AdminOperationsPanel';
import {CatalogPanel} from './CatalogPanel';
import {InventoryAdjustmentPanel} from './InventoryAdjustmentPanel';
import {AdminHistoryPanel} from './AdminHistoryPanel';
import './admin.css';
import {OwnerDashboardPanel} from './OwnerDashboardPanel';
import {StockMinimumPanel} from './StockMinimumPanel';
import {FinanceExpensesPanel} from './FinanceExpensesPanel';
import {FinanceSummaryPanel} from './FinanceSummaryPanel';
export function AdminPanel({onChanged,initialSection='owner'}:{onChanged:()=>Promise<void>;initialSection?:'owner'|'operations'}){
 const [pending,setPending]=useState<AdminAttempt|null>(null);
 const [checkError,setCheckError]=useState('');const [checking,setChecking]=useState(false);const [missing,setMissing]=useState(false);const [verifiedNotice,setVerifiedNotice]=useState('');
 async function refreshPending(){try{setPending(await getAdminAttempt());}catch(e){setCheckError(e instanceof Error?e.message:'Error');}}
 useEffect(()=>{void refreshPending();const listener=()=>void refreshPending();window.addEventListener('focus',listener);window.addEventListener('im-admin-pending-change',listener);return()=>{window.removeEventListener('focus',listener);window.removeEventListener('im-admin-pending-change',listener)}},[]);
 async function verify(){if(!pending)return;setChecking(true);setCheckError('');setVerifiedNotice('');setMissing(false);try{const result=await verifyAdminAttempt(pending);if(result==='found'){await clearAdminAttempt(pending);setPending(null);setVerifiedNotice('Operación encontrada en Supabase. No se repitió ni se volvió a modificar el inventario.');await onChanged();}else setMissing(true);}catch(e){setCheckError(e instanceof Error?e.message:'No se pudo verificar');}finally{setChecking(false)}}
 async function discard(){if(!pending||!missing)return;if(!window.confirm('La consulta no encontró el movimiento. ¿Descartar el intento? No lo hagás si la operación sigue procesándose en otro dispositivo.'))return;await clearAdminAttempt(pending);setPending(null);setMissing(false)}
 const [section,setSection]=useState<'operations'|'catalog'|'adjustments'|'history'|'expenses'|'finance'|'owner'|'minimum'|'tools'|'sales'>(initialSection);
 useEffect(()=>setSection(initialSection),[initialSection]);
 const group=section==='owner'?'owner':(['finance','expenses','history','sales'] as string[]).includes(section)?'finance':'tools';
 const tools=[
  {id:'operations',label:'Compras y precios',description:'Registrar mercadería recibida o cambiar un precio.'},
  {id:'catalog',label:'Productos',description:'Crear y editar familias y presentaciones.'},
  {id:'adjustments',label:'Mermas y ajustes',description:'Registrar pérdidas o diferencias de inventario.'},
  {id:'minimum',label:'Stock mínimo',description:'Definir cuándo un producto necesita reposición.'}
 ] as const;
 return <section className="admin-root">{verifiedNotice&&<p role="status" className="admin-ok">{verifiedNotice}</p>}{pending&&<div className="admin-form" role="alert"><h3>Operación por verificar</h3><p>{pending.label}</p><p>Solicitud: {pending.id.slice(0,8)} · No repitás la operación hasta verificarla.</p><button onClick={()=>void verify()} disabled={checking}>{checking?'Verificando…':'Verificar en Supabase'}</button>{missing&&<><p>No se encontró el movimiento. Revisá que la solicitud haya terminado antes de descartarla.</p><button onClick={()=>void discard()}>Descartar intento sin registro</button></>}{checkError&&<p className="admin-error">{checkError}</p>}</div>}
 <nav className="admin-primary-nav" aria-label="Administración">
  {([['owner','Mi negocio'],['tools','Operaciones'],['finance','Finanzas']] as const).map(([id,label])=><button key={id} aria-current={group===id?'page':undefined} onClick={()=>setSection(id)}>{label}</button>)}
 </nav>
 {group==='finance'&&<nav className="admin-context-nav" aria-label="Finanzas">
  {([['finance','Resultados'],['expenses','Gastos'],['sales','Ventas'],['history','Movimientos']] as const).map(([id,label])=><button key={id} aria-current={section===id?'page':undefined} onClick={()=>setSection(id)}>{label}</button>)}
 </nav>}
 {group==='tools'&&section!=='tools'&&<div className="admin-context-back"><button onClick={()=>setSection('tools')}>Todas las operaciones</button></div>}
 <div className="admin-workspace"><AdminSectionBoundary key={section}>{pending?null:section==='tools'?<section className="admin-tools-index"><header><h2>Operaciones</h2><p>Elegí lo que necesitás hacer.</p></header><div className="admin-action-list">{tools.map(tool=><button key={tool.id} onClick={()=>setSection(tool.id)}><span><strong>{tool.label}</strong><small>{tool.description}</small></span><span aria-hidden="true">→</span></button>)}</div></section>:section==='operations'?<AdminOperationsPanel onChanged={onChanged}/>:section==='catalog'?<CatalogPanel onChanged={onChanged}/>:section==='adjustments'?<InventoryAdjustmentPanel onChanged={onChanged}/>:section==='sales'?<SalesHistoryPanel/>:section==='history'?<AdminHistoryPanel/>:section==='expenses'?<FinanceExpensesPanel/>:section==='finance'?<FinanceSummaryPanel/>:section==='owner'?<OwnerDashboardPanel/>:<StockMinimumPanel/>}</AdminSectionBoundary></div></section>;
}
