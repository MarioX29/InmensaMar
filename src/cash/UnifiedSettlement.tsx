import {useCallback,useEffect,useRef,useState} from 'react';
import {supabase} from '../lib/supabase';

type Preview={cash_day_id:string;driver_id:string;driver_name:string;float_cents:number;collected_cents:number;purchases_cents:number;expected_cents:number;settled:boolean};
type Purchase={id:string;driver_id:string;description:string;amount_cents:number;category:'personal'|'business';status:string};
const money=(n:number)=>`Q ${(Number(n)/100).toFixed(2)}`;
const parse=(v:string)=>{const cents=Math.round(Number(v.trim())*100);return /^\d+(?:\.\d{1,2})?$/.test(v.trim())&&Number.isSafeInteger(cents)?cents:null;};
export function UnifiedSettlement({onChanged,onSummary,refreshSignal,cashDayStatus}:{onChanged?:()=>void;onSummary?:(value:{pending:number;settled:number}|null)=>void;refreshSignal?:number;cashDayStatus?:string}){
 const [rows,setRows]=useState<Preview[]>([]),[amounts,setAmounts]=useState<Record<string,string>>({});
 const [purchases,setPurchases]=useState<Purchase[]>([]);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const attempt=useRef<{id:string;day:string;driver:string;counted:number;preview:Preview}|null>(null);
 const load=useCallback(async()=>{
  if(!supabase)return;
  const {data,error:e}=await supabase.rpc('driver_day_settlement_preview');
  if(e){setRows([]);setError(e.message);onSummary?.(null);return;}
  const previews=(data||[]) as Preview[];
  if(previews.length){
   const result=await supabase.from('driver_cash_errands').select('id,driver_id,description,amount_cents,category,status').eq('cash_day_id',previews[0].cash_day_id).order('created_at');
   if(result.error){setRows([]);setPurchases([]);setError(result.error.message);onSummary?.(null);return;}
   setPurchases((result.data||[]) as Purchase[]);
  }else setPurchases([]);
  setRows(previews);setError('');onSummary?.({pending:previews.filter(r=>!r.settled).length,settled:previews.filter(r=>r.settled).length});
 },[onSummary]);
 useEffect(()=>{void load();},[load,refreshSignal,cashDayStatus]);
 async function settle(r:Preview){
  if(!supabase||busy)return;
  const counted=parse(amounts[r.driver_id]||'');
  if(counted===null||counted<0){setError('Ingresá el efectivo contado (Q0 o más).');return;}
  if(attempt.current&&(attempt.current.driver!==r.driver_id||attempt.current.day!==r.cash_day_id||attempt.current.counted!==counted)){
   setError('Hay una liquidación sin verificar. No cambiés el monto ni el repartidor.');return;
  }
  if(!attempt.current&&!window.confirm(`¿Confirmás que Caja entregó ${money(r.float_cents)} de sencillo a ${r.driver_name} y que ahora recibiste ${money(counted)}? Diferencia del repartidor: ${money(counted-Number(r.expected_cents))}. Se revisan sus compras y se registra el sencillo una sola vez.`))return;
  if(!attempt.current)attempt.current={id:crypto.randomUUID(),day:r.cash_day_id,driver:r.driver_id,counted,preview:r};
  setBusy(true);setError('');setNotice('');
  try{
   const a=attempt.current;
   const {error:e}=await supabase.rpc('settle_driver_day',{p_request_id:a.id,p_cash_day_id:a.day,p_driver_id:a.driver,p_counted_cents:a.counted,p_reviewed_preview:a.preview});
   if(e){if(e.code==='P0001')attempt.current=null;setError(e.message+' Revisá el registro antes de reintentar.');return;}
   attempt.current=null;setNotice('Liquidación registrada y compras revisadas.');await load();onChanged?.();
  }catch(e){setError(String(e)+' Resultado incierto. Conservá el intento y verificá antes de repetir.');}
  finally{setBusy(false);}
 }
 return <section className="cash-card cash-settlements" aria-label="Liquidación única de repartidores">
  <div className="cash-section-head"><div><p className="cash-eyebrow">REPARTO</p><h2>Liquidaciones</h2></div><button className="cash-text-button" type="button" disabled={busy} onClick={()=>void load()}>Actualizar</button></div>
  <p>Elegí al repartidor para revisar sencillo, cobros y compras.</p>
  {rows.length===0&&!error?<p className="cash-empty">Sin movimientos de repartidores para la jornada abierta.</p>:rows.map(r=><details className="cash-driver" key={r.driver_id}>
   <summary><span className="cash-avatar" aria-hidden="true">{r.driver_name.trim().charAt(0).toUpperCase()}</span><span className="cash-driver-name"><strong>{r.driver_name}</strong><small>{r.settled?'Liquidado':'Pendiente de liquidar'}</small></span><span className="cash-driver-amount"><strong>{money(r.expected_cents)}</strong><small>{r.settled?'Esperado · Ver detalle':'Esperado · Revisar →'}</small></span></summary>
   <div className="cash-driver-body">
    <div className="cash-driver-metrics"><div><span>Sencillo</span><strong>{money(r.float_cents)}</strong></div><div><span>Cobros</span><strong>{money(r.collected_cents)}</strong></div><div><span>Compras</span><strong>−{money(r.purchases_cents)}</strong></div></div>
    <div className="cash-line cash-line-total"><span>Efectivo esperado del repartidor</span><strong>{money(r.expected_cents)}</strong></div>
    {purchases.filter(p=>p.driver_id===r.driver_id).length>0&&<div className="cash-purchases"><h3>Compras reportadas</h3>{purchases.filter(p=>p.driver_id===r.driver_id).map(p=><div className="cash-purchase" key={p.id}><span><strong>{p.description}</strong><small>{p.category==='personal'?'Retiro personal':'Gasto del negocio'}{p.status==='rejected'?' · Rechazada, no descontada':''}</small></span><strong>{money(p.amount_cents)}</strong></div>)}</div>}
    {!r.settled&&<>
     <p>Al confirmar revisás también que los {money(r.float_cents)} de sencillo hayan salido de Caja. Las compras ya están descontadas del esperado.</p>
     <label htmlFor={`settle-${r.driver_id}`}>Efectivo contado (Q)<input id={`settle-${r.driver_id}`} className="cash-amount-input" inputMode="decimal" value={amounts[r.driver_id]||''} disabled={busy||!!attempt.current} placeholder="0.00" onChange={e=>setAmounts(v=>({...v,[r.driver_id]:e.target.value}))}/></label>
     {parse(amounts[r.driver_id]||'')!==null&&<div className="cash-line"><span>Diferencia del repartidor</span><strong>{money((parse(amounts[r.driver_id]||'')??0)-Number(r.expected_cents))}</strong></div>}
     <button className="cash-primary" type="button" disabled={busy||(!!attempt.current&&attempt.current.driver!==r.driver_id)} onClick={()=>void settle(r)}>{busy?'Registrando…':attempt.current?.driver===r.driver_id?'Reintentar misma liquidación':'Confirmar liquidación'}</button>
     <small>Terminá sus entregas antes de liquidar: después se bloquean nuevos cobros de esta jornada.</small>
    </>}
   </div>
  </details>)}
  {error&&<p className="cash-error" role="alert">{error}</p>}{notice&&<p className="cash-notice" role="status">{notice}</p>}
  {attempt.current&&<p className="cash-error">Resultado incierto: verificá el registro o reintentá la misma liquidación. Conservamos el monto y el identificador para evitar duplicados.</p>}
 </section>;
}
