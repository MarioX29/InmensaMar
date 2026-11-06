import {useEffect,useState} from 'react';
import {supabase} from '../lib/supabase';
import type {DeliveryPreferences} from '../storefront/orderClient';
import './order-delivery-info.css';
export type DeliveryInfo={order_id:string;delivery_preferences:DeliveryPreferences|null;notes:string|null};
export function useDeliveryPreferences(orderIds:string[]){
 const key=[...new Set(orderIds)].sort().join(',');
 const [rows,setRows]=useState<Record<string,DeliveryInfo>>({}),[failed,setFailed]=useState(false);
 const [version,setVersion]=useState(0);
 useEffect(()=>{
  let active=true;
  setRows({});setFailed(false);
  if(!key||!supabase)return;
  const ids=key.split(',');
  async function load(){
   try{
    const collected:DeliveryInfo[]=[];
    for(let i=0;i<ids.length;i+=100){
     const result=await supabase!.rpc('order_delivery_preferences',{p_order_ids:ids.slice(i,i+100)});
     if(result.error||!Array.isArray(result.data))throw new Error('delivery preferences unavailable');
     collected.push(...result.data as DeliveryInfo[]);
    }
    if(active){setRows(Object.fromEntries(collected.map(row=>[row.order_id,row])));setFailed(false)}
   }catch{if(active){setRows({});setFailed(true)}}
  }
  void load();
  const refresh=()=>{if(document.visibilityState==='visible')void load()};
  window.addEventListener('focus',refresh);const timer=window.setInterval(refresh,30000);
  return()=>{active=false;window.removeEventListener('focus',refresh);window.clearInterval(timer)};
 },[key,version]);
 return {rows,failed,retry:()=>setVersion(v=>v+1)};
}
const money=(value:number)=>`Q ${(value/100).toFixed(2)}`;
export function OrderDeliveryInfo({info,totalCents,showNotes=false,links=true}:{info?:DeliveryInfo;totalCents:number;showNotes?:boolean;links?:boolean}){
 if(!info)return null;
 const p=info.delivery_preferences;
 const hasCoordinates=p?.latitude!=null&&p?.longitude!=null&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180;
 const maps=hasCoordinates?`https://www.google.com/maps/search/?api=1&query=${p!.latitude},${p!.longitude}`:p?.maps_url||'';
 const safeMaps=/^https:\/\/(?:maps\.app\.goo\.gl\/[A-Za-z0-9_-]+|goo\.gl\/maps\/[A-Za-z0-9_-]+|(?:www\.)?google\.com\/maps(?:[/?#][^\s]*)?|maps\.google\.com\/(?:[^\s]*))$/.test(maps);
 return <div className="order-delivery-info">
  {showNotes&&info.notes&&<p><strong>Indicaciones:</strong> {info.notes}</p>}
  {p&&<>
   <p><strong>Pago indicado por el cliente:</strong> {p.payment_method==='transfer'?'Transferencia; pendiente de verificación.':p.cash_mode==='exact'?'Efectivo exacto.':`Efectivo; pagará con ${money(p.cash_tendered_cents||0)}.`}</p>
   {p.payment_method==='cash'&&p.cash_mode==='change'&&<p className={(p.cash_tendered_cents||0)<totalCents?'order-delivery-warning':''}><strong>{(p.cash_tendered_cents||0)<totalCents?'Confirmar efectivo:':'Vuelto estimado para llevar:'}</strong> {(p.cash_tendered_cents||0)<totalCents?'El monto indicado ya no cubre el total. Consultá al cliente.':money((p.cash_tendered_cents||0)-totalCents)}</p>}
   <small>Preferencia del cliente; confirmá el cobro real al entregar.</small>
   {safeMaps&&links&&<div className="order-delivery-links"><a href={maps} target="_blank" rel="noopener noreferrer">Ver ubicación de entrega</a>{hasCoordinates&&<a href={`https://waze.com/ul?ll=${p.latitude},${p.longitude}&navigate=yes`} target="_blank" rel="noopener noreferrer">Ir con Waze</a>}</div>}
  </>}
 </div>;
}
