import {useEffect,useState} from 'react';
import {AdminAttempt,getAdminAttempt,verifyAdminAttempt,clearAdminAttempt} from './AdminPending';
import {AdminOperationsPanel} from './AdminOperationsPanel';
import {CatalogPanel} from './CatalogPanel';
import {InventoryAdjustmentPanel} from './InventoryAdjustmentPanel';
import {AdminHistoryPanel} from './AdminHistoryPanel';
import './admin.css';
import {FinanceExpensesPanel} from './FinanceExpensesPanel';
export function AdminPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [pending,setPending]=useState<AdminAttempt|null>(null);
 const [checkError,setCheckError]=useState('');const [checking,setChecking]=useState(false);const [missing,setMissing]=useState(false);const [verifiedNotice,setVerifiedNotice]=useState('');
 async function refreshPending(){try{setPending(await getAdminAttempt());}catch(e){setCheckError(e instanceof Error?e.message:'Error');}}
 useEffect(()=>{void refreshPending();const listener=()=>void refreshPending();window.addEventListener('focus',listener);window.addEventListener('im-admin-pending-change',listener);return()=>{window.removeEventListener('focus',listener);window.removeEventListener('im-admin-pending-change',listener)}},[]);
 async function verify(){if(!pending)return;setChecking(true);setCheckError('');setVerifiedNotice('');setMissing(false);try{const result=await verifyAdminAttempt(pending);if(result==='found'){await clearAdminAttempt(pending);setPending(null);setVerifiedNotice('Operación encontrada en Supabase. No se repitió ni se volvió a modificar el inventario.');await onChanged();}else setMissing(true);}catch(e){setCheckError(e instanceof Error?e.message:'No se pudo verificar');}finally{setChecking(false)}}
 async function discard(){if(!pending||!missing)return;if(!window.confirm('La consulta no encontró el movimiento. ¿Descartar el intento? No lo hagás si la operación sigue procesándose en otro dispositivo.'))return;await clearAdminAttempt(pending);setPending(null);setMissing(false)}
 const [section,setSection]=useState<'operations'|'catalog'|'adjustments'|'history'|'expenses'>('operations');
 return <section className="admin-root">{verifiedNotice&&<p role="status" className="admin-ok">{verifiedNotice}</p>}{pending&&<div className="admin-form" role="alert"><h3>Operación por verificar</h3><p>{pending.label}</p><p>Solicitud: {pending.id.slice(0,8)} · No repitás la operación hasta verificarla.</p><button onClick={()=>void verify()} disabled={checking}>{checking?'Verificando…':'Verificar en Supabase'}</button>{missing&&<><p>No se encontró el movimiento. Revisá que la solicitud haya terminado antes de descartarla.</p><button onClick={()=>void discard()}>Descartar intento sin registro</button></>}{checkError&&<p className="admin-error">{checkError}</p>}</div>}<div className="admin-switch admin-switch-four">
  <button className={section==='operations'?'selected':''} onClick={()=>setSection('operations')}>Compras y precios</button>
  <button className={section==='catalog'?'selected':''} onClick={()=>setSection('catalog')}>Productos</button>
  <button className={section==='adjustments'?'selected':''} onClick={()=>setSection('adjustments')}>Ajustes</button>
  <button className={section==='history'?'selected':''} onClick={()=>setSection('history')}>Historial</button>
  <button className={section==='expenses'?'selected':''} onClick={()=>setSection('expenses')}>Gastos</button>
 </div>{pending?null:section==='operations'?<AdminOperationsPanel onChanged={onChanged}/>:section==='catalog'?<CatalogPanel onChanged={onChanged}/>:section==='adjustments'?<InventoryAdjustmentPanel onChanged={onChanged}/>:section==='history'?<AdminHistoryPanel/>:<FinanceExpensesPanel/>}</section>;
}
