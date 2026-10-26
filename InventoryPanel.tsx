import {useState} from 'react';
type Product={id:string;name:string;family:string;unit:'lb'|'unit'|'package';priceCents:number;stock:number};
const money=(c:number)=>`Q ${(c/100).toFixed(2)}`;
const units={lb:'lb',unit:'unidad',package:'paquete'};
export function InventoryPanel({products,onPurchase}:{products:Product[];onPurchase?:()=>void}){
 const [search,setSearch]=useState('');
 const [filter,setFilter]=useState<'all'|'available'|'empty'>('all');
 const [family,setFamily]=useState('all');
 const families=[...new Set(products.map(p=>p.family))].sort();
 const visible=products.filter(p=>(family==='all'||p.family===family)&&(filter==='all'||(filter==='empty'?p.stock<=0:p.stock>0))&&`${p.name} ${p.family}`.toLocaleLowerCase('es-GT').includes(search.trim().toLocaleLowerCase('es-GT')));
 return <section className="inventory-module">
  <div className="module-metrics"><div><span>Presentaciones activas</span><strong>{products.length}</strong></div><div><span>Con existencias</span><strong>{products.filter(p=>p.stock>0).length}</strong></div><div><span>Agotadas</span><strong>{products.filter(p=>p.stock<=0).length}</strong></div></div>
  <div className="module-toolbar"><label className="module-search"><span className="sr-only">Buscar en inventario</span><input type="search" placeholder="Buscar producto o presentación" value={search} onChange={e=>setSearch(e.target.value)}/></label>{onPurchase&&<button className="primary" onClick={onPurchase}>Registrar compra</button>}</div>
  <div className="inventory-filters"><div className="segment-control" aria-label="Disponibilidad">{([['all','Todos'],['available','Disponibles'],['empty','Agotados']] as const).map(([id,label])=><button key={id} aria-pressed={filter===id} onClick={()=>setFilter(id)}>{label}</button>)}</div><label><span className="sr-only">Familia de productos</span><select aria-label="Familia de productos" value={family} onChange={e=>setFamily(e.target.value)}><option value="all">Todas las familias</option>{families.map(f=><option key={f} value={f}>{f}</option>)}</select></label></div>
  <div className="inventory-list"><div className="inventory-list-head"><span>Producto</span><span>Precio de venta</span><span>Disponible</span></div>{visible.map(p=><article className="inventory-row" key={p.id}><div className="inventory-product"><span className="inventory-initial" aria-hidden="true">{p.family.slice(0,1).toUpperCase()}</span><div><strong>{p.name}</strong><small>{p.family}</small></div></div><div className="inventory-price">{money(p.priceCents)}<small> / {units[p.unit]}</small></div><div className="inventory-stock" data-empty={p.stock<=0}><strong>{Number(p.stock).toLocaleString('es-GT',{maximumFractionDigits:4})}</strong><small>{units[p.unit]}{p.stock<=0?' · Agotado':''}</small></div></article>)}</div>
  {!visible.length&&<div className="module-empty"><strong>{products.length?'No hay coincidencias':'Todavía no hay productos'}</strong><p>{products.length?'Probá otra búsqueda o disponibilidad.':'Registrá los productos y sus compras para ver las existencias.'}</p></div>}
  <p className="module-caption">Disponible para vender. Las reservas, vencimientos y disponibilidad de lotes se calculan en el inventario existente. Las cantidades de unidades distintas se muestran por separado.</p>
 </section>;
}
