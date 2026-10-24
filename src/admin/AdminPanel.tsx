import {useState} from 'react';
import {AdminOperationsPanel} from './AdminOperationsPanel';
import {CatalogPanel} from './CatalogPanel';
import './admin.css';
export function AdminPanel({onChanged}:{onChanged:()=>Promise<void>}){
 const [section,setSection]=useState<'operations'|'catalog'>('operations');
 return <section className="admin-root"><div className="admin-switch"><button className={section==='operations'?'selected':''} onClick={()=>setSection('operations')}>Compras y precios</button><button className={section==='catalog'?'selected':''} onClick={()=>setSection('catalog')}>Productos</button></div>{section==='operations'?<AdminOperationsPanel onChanged={onChanged}/>:<CatalogPanel onChanged={onChanged}/>}</section>;
}
