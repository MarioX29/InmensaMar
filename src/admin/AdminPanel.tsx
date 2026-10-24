import {useState} from 'react';
import {AdminOperationsPanel} from './AdminOperationsPanel';
import {CatalogPanel} from './CatalogPanel';
import {InventoryAdjustmentPanel} from './InventoryAdjustmentPanel';
import {AdminHistoryPanel} from './AdminHistoryPanel';
import './admin.css';
export function AdminPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [section,setSection]=useState<'operations'|'catalog'|'adjustments'|'history'>('operations');
 return <section className="admin-root"><div className="admin-switch admin-switch-four">
  <button className={section==='operations'?'selected':''} onClick={()=>setSection('operations')}>Compras y precios</button>
  <button className={section==='catalog'?'selected':''} onClick={()=>setSection('catalog')}>Productos</button>
  <button className={section==='adjustments'?'selected':''} onClick={()=>setSection('adjustments')}>Ajustes</button>
  <button className={section==='history'?'selected':''} onClick={()=>setSection('history')}>Historial</button>
 </div>{section==='operations'?<AdminOperationsPanel onChanged={onChanged}/>:section==='catalog'?<CatalogPanel onChanged={onChanged}/>:section==='adjustments'?<InventoryAdjustmentPanel onChanged={onChanged}/>:<AdminHistoryPanel/>}</section>;
}
