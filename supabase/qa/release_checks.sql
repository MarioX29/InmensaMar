-- QA corregido: ejecutar después de la migración integrada.
-- Descarta la transacción fallida anterior si la conexión aún la conserva.
ROLLBACK;
-- Todos los fixtures de este QA se revierten al terminar.
BEGIN;
CREATE TEMP TABLE delivery_preferences_qa(test text,result text) ON COMMIT DROP;
DO $$
DECLARE
 f uuid;v uuid;rid uuid:=gen_random_uuid();orderid uuid;transferid uuid;legacyid uuid;
 a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();c uuid:=gen_random_uuid();routeid uuid;
 req uuid;result jsonb;retry jsonb;items jsonb;p jsonb;bad jsonb;hash text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
 count_before integer;stock_before numeric;reserved_before numeric;
BEGIN
 INSERT INTO public.product_families(name) VALUES('QA entrega '||rid::text) RETURNING id INTO f;
 INSERT INTO public.product_variants(family_id,name,base_unit,price_cents,active) VALUES(f,'Libra QA','lb',4500,true) RETURNING id INTO v;
 INSERT INTO public.inventory_lots(variant_id,qty_received,qty_on_hand,qty_reserved,cost_cents_per_base_unit,status) VALUES(v,20,20,2,2000,'available');
 items:=jsonb_build_array(jsonb_build_object('variant_id',v,'quantity',0.5,'expected_unit_price_cents',4500));
 p:='{"latitude":14.6349,"longitude":-90.5069,"maps_url":"","payment_method":"cash","cash_mode":"change","cash_tendered_cents":10000}'::jsonb;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 result:=public.submit_storefront_order_v2(rid,'QA Cliente','55551234','Dirección QA zona 1','Portón azul',items,hash,p);
 orderid:=(result->>'order_id')::uuid;
 IF (result->>'total_cents')::bigint<>2250 OR NOT EXISTS(SELECT 1 FROM public.customer_orders WHERE id=orderid AND delivery_preferences=p) THEN RAISE EXCEPTION 'FAIL preferences'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Ubicación, efectivo y monto para vuelto guardados con total del servidor','PASS');
 retry:=public.submit_storefront_order_v2(rid,'QA Cliente','55551234','Dirección QA zona 1','Portón azul',items,repeat('b',64),p);
 IF retry<>result OR (SELECT count(*) FROM public.customer_orders WHERE request_id=rid)<>1 THEN RAISE EXCEPTION 'FAIL retry'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Reintento idéntico conserva el mismo pedido','PASS');
 BEGIN
  PERFORM public.submit_storefront_order_v2(rid,'QA Cliente','55551234','Dirección QA zona 1','Portón azul',items,hash,jsonb_set(p,'{cash_tendered_cents}','20000'));
  RAISE EXCEPTION 'FAIL altered';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'REQUEST_CONFLICT' THEN RAISE; END IF; END;
 INSERT INTO delivery_preferences_qa VALUES('Cambiar ubicación o pago en un reintento no altera el pedido','PASS');
 SELECT orders_count INTO count_before FROM public.storefront_rate_windows WHERE client_hash=hash;
 req:=gen_random_uuid();
 BEGIN
  PERFORM public.submit_storefront_order_v2(req,'QA Cliente','55551234','Dirección QA zona 1','',items,hash,jsonb_set(p,'{cash_tendered_cents}','1000'));
  RAISE EXCEPTION 'FAIL insufficient';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'INVALID_REQUEST' THEN RAISE; END IF; END;
 IF EXISTS(SELECT 1 FROM public.customer_orders WHERE request_id=req) OR EXISTS(SELECT 1 FROM public.storefront_order_requests WHERE request_id=req)
  OR (SELECT orders_count FROM public.storefront_rate_windows WHERE client_hash=hash)<>count_before THEN RAISE EXCEPTION 'FAIL partial or rate'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Efectivo insuficiente revierte pedido, detalle y contador de solicitudes','PASS');
 FOR bad IN SELECT x FROM jsonb_array_elements(jsonb_build_array(
  jsonb_set(p,'{latitude}','91'),jsonb_set(p,'{longitude}','null'),jsonb_set(p,'{cash_tendered_cents}','10000.5'),
  jsonb_set(p,'{cash_tendered_cents}','"10000"'),p-'payment_method',p||'{"unexpected":true}'::jsonb,
  jsonb_set(p,'{payment_method}','"card"'),jsonb_set(p,'{latitude}','"14.5"'),
  jsonb_set(p,'{maps_url}','"javascript:alert(1)"'),jsonb_set(p,'{maps_url}','"https://maps.app.goo.gl.evil.test/x"'),
  jsonb_set(p,'{maps_url}','"https://user@maps.google.com/x"'),jsonb_set(p,'{maps_url}','"https://maps.app.goo.gl/abc"')
 )) x LOOP
  BEGIN
   PERFORM public.submit_storefront_order_v2(gen_random_uuid(),'QA Cliente','55551234','Dirección QA zona 1','',items,hash,bad);
   RAISE EXCEPTION 'FAIL invalid preferences';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'INVALID_REQUEST' THEN RAISE; END IF; END;
 END LOOP;
 INSERT INTO delivery_preferences_qa VALUES('Rechaza coordenadas, enlaces, importes y opciones inválidos','PASS');
 p:='{"latitude":null,"longitude":null,"maps_url":"https://maps.app.goo.gl/ExampleQA","payment_method":"transfer","cash_mode":null,"cash_tendered_cents":null}'::jsonb;
 result:=public.submit_storefront_order_v2(gen_random_uuid(),'QA Cliente','55551234','Dirección QA zona 1','',items,hash,p);
 transferid:=(result->>'order_id')::uuid;
 IF EXISTS(SELECT 1 FROM public.delivery_payment_events WHERE order_id=transferid) THEN RAISE EXCEPTION 'FAIL transfer recorded as payment'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Transferencia es una preferencia y no crea un cobro','PASS');
 p:='{"latitude":null,"longitude":null,"maps_url":"","payment_method":"cash","cash_mode":"exact","cash_tendered_cents":null}'::jsonb;
 PERFORM public.submit_storefront_order_v2(gen_random_uuid(),'QA Cliente','55551234','Dirección QA zona 1','',items,hash,p);
 INSERT INTO delivery_preferences_qa VALUES('Pago exacto y pedido sin ubicación opcional aceptados','PASS');
 req:=gen_random_uuid();
 result:=public.submit_storefront_order(req,'QA Cliente','55551234','Dirección QA zona 1','',items,hash);
 legacyid:=(result->>'order_id')::uuid;
 retry:=public.submit_storefront_order(req,'QA Cliente','55551234','Dirección QA zona 1','',items,hash);
 IF retry<>result THEN RAISE EXCEPTION 'FAIL legacy'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Solicitudes anteriores sin preferencias conservan su reintento','PASS');
 IF EXISTS(SELECT 1 FROM public.inventory_lots WHERE variant_id=v AND (qty_on_hand<>20 OR qty_reserved<>2)) THEN RAISE EXCEPTION 'FAIL stock changed'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Las preferencias no reservan ni descuentan inventario','PASS');
 IF has_function_privilege('anon','public.submit_storefront_order_v2(uuid,text,text,text,text,jsonb,text,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','public.submit_storefront_order_v2(uuid,text,text,text,text,jsonb,text,jsonb)','EXECUTE')
  OR has_function_privilege('anon','public.order_delivery_preferences(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'FAIL grants'; END IF;
 PERFORM set_config('request.jwt.claims','{"role":"authenticated"}',true);
 BEGIN
  PERFORM public.submit_storefront_order_v2(gen_random_uuid(),'QA Cliente','55551234','Dirección QA zona 1','',items,hash,p);
  RAISE EXCEPTION 'FAIL role';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Not authorized' THEN RAISE; END IF; END;
 INSERT INTO delivery_preferences_qa VALUES('Escritura solo de servidor y lectura pública bloqueada','PASS');
 INSERT INTO auth.users(id,email) VALUES(a,'qa-'||a||'@example.invalid'),(b,'qa-'||b||'@example.invalid'),(c,'qa-'||c||'@example.invalid');
 INSERT INTO public.staff_profiles(user_id,display_name,role,active) VALUES(a,'QA Reparto A','driver',true),(b,'QA Reparto B','driver',true),(c,'QA Mostrador','counter',true)
 ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,active=true;
 UPDATE public.customer_orders SET status='ready' WHERE id=orderid;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',a)::text,true);
 IF (SELECT count(*) FROM public.order_delivery_preferences(ARRAY[orderid,transferid]))<>1 THEN RAISE EXCEPTION 'FAIL driver ready access'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Repartidor puede ver preferencias de pedidos listos disponibles','PASS');
 INSERT INTO public.delivery_routes(request_id,label,driver_id,created_by) VALUES(gen_random_uuid(),'QA Ruta',b,c) RETURNING id INTO routeid;
 INSERT INTO public.delivery_assignments(order_id,route_id,assigned_by,stop_order) VALUES(orderid,routeid,c,1);
 UPDATE public.customer_orders SET status='out_for_delivery' WHERE id=orderid;
 IF EXISTS(SELECT 1 FROM public.order_delivery_preferences(ARRAY[orderid])) THEN RAISE EXCEPTION 'FAIL other driver'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Repartidor no ve ubicación ni notas de entregas ajenas','PASS');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',b)::text,true);
 IF NOT EXISTS(SELECT 1 FROM public.order_delivery_preferences(ARRAY[orderid]) WHERE notes='Portón azul' AND delivery_preferences IS NOT NULL) THEN RAISE EXCEPTION 'FAIL own delivery'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Repartidor asignado recibe ubicación, pago e indicaciones','PASS');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',c)::text,true);
 IF (SELECT count(*) FROM public.order_delivery_preferences(ARRAY[orderid,transferid,legacyid]))<>3 THEN RAISE EXCEPTION 'FAIL counter'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Mostrador consulta preferencias de los pedidos internos y públicos','PASS');
 UPDATE public.staff_profiles SET active=false WHERE user_id=c;
 BEGIN
  PERFORM public.order_delivery_preferences(ARRAY[orderid]); RAISE EXCEPTION 'FAIL inactive';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Not authorized' THEN RAISE; END IF; END;
 INSERT INTO delivery_preferences_qa VALUES('Personal inactivo no puede consultar preferencias','PASS');
END; $$;

DO $$
DECLARE
 counter_id uuid:=gen_random_uuid();admin_id uuid:=gen_random_uuid();sale_id uuid;payment_id uuid;request_id uuid:=gen_random_uuid();
BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND (
   has_table_privilege('anon',c.oid,'TRUNCATE') OR has_table_privilege('authenticated',c.oid,'TRUNCATE')
   OR has_table_privilege('anon',c.oid,'TRIGGER') OR has_table_privilege('authenticated',c.oid,'TRIGGER')
   OR has_table_privilege('anon',c.oid,'REFERENCES') OR has_table_privilege('authenticated',c.oid,'REFERENCES')
   OR has_table_privilege('anon',c.oid,'MAINTAIN') OR has_table_privilege('authenticated',c.oid,'MAINTAIN')))
 THEN RAISE EXCEPTION 'FAIL excess table privileges'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Anon y usuarios autenticados sin permisos administrativos en tablas','PASS');
 IF EXISTS(SELECT 1 FROM pg_default_acl d JOIN pg_namespace n ON n.oid=d.defaclnamespace,
  LATERAL aclexplode(d.defaclacl) a JOIN pg_roles role ON role.oid=a.grantee
  WHERE n.nspname='public' AND d.defaclrole='postgres'::regrole AND d.defaclobjtype='r'
   AND role.rolname IN ('anon','authenticated') AND a.privilege_type IN ('TRUNCATE','TRIGGER','REFERENCES','MAINTAIN'))
 THEN RAISE EXCEPTION 'FAIL default privileges'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Tablas futuras no heredan permisos administrativos para clientes','PASS');
 IF has_function_privilege('authenticated','public.close_cash_day(uuid,uuid,bigint,bigint)','EXECUTE')
 OR has_function_privilege('authenticated','public.settle_driver_day(uuid,uuid,uuid,bigint)','EXECUTE')
 OR has_function_privilege('anon','public.close_cash_day(uuid,uuid,bigint,bigint)','EXECUTE')
 OR has_function_privilege('anon','public.settle_driver_day(uuid,uuid,uuid,bigint)','EXECUTE')
 THEN RAISE EXCEPTION 'FAIL internal signatures exposed'; END IF;
 IF NOT has_function_privilege('authenticated','public.close_cash_day(uuid,uuid,bigint,bigint,jsonb,boolean)','EXECUTE')
 OR NOT has_function_privilege('authenticated','public.settle_driver_day(uuid,uuid,uuid,bigint,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'FAIL reviewed signatures unavailable'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Funciones revisadas disponibles y versiones internas cerradas','PASS');
 INSERT INTO auth.users(id,email) VALUES(counter_id,'qa-'||counter_id||'@example.invalid'),(admin_id,'qa-'||admin_id||'@example.invalid');
 INSERT INTO public.staff_profiles(user_id,display_name,role,active) VALUES(counter_id,'QA Mostrador transferencia','counter',true),(admin_id,'QA Admin transferencia','admin',true)
 ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,active=true;
 INSERT INTO public.sales(request_id,request_fingerprint,cashier_id,total_cents,status)
 VALUES(gen_random_uuid(),'qa-transferencia',counter_id,2250,'completed') RETURNING id INTO sale_id;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',counter_id)::text,true);
 BEGIN
  PERFORM public.record_sale_payment(request_id,sale_id,'transfer',2250,false);
  RAISE EXCEPTION 'FAIL unverified transfer accepted';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Las transferencias deben registrarse pendientes de verificación' THEN RAISE; END IF; END;
 INSERT INTO delivery_preferences_qa VALUES('Mostrador no puede registrar una transferencia como recibida','PASS');
 payment_id:=public.record_sale_payment(request_id,sale_id,'transfer',2250,true);
 IF NOT EXISTS(SELECT 1 FROM public.sale_payments p WHERE p.id=payment_id AND p.status='pending_verification' AND p.verified_at IS NULL)
 THEN RAISE EXCEPTION 'FAIL transfer not pending'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Transferencia de mostrador se guarda pendiente de verificación','PASS');
 BEGIN
  PERFORM public.verify_transfer_payment(payment_id);RAISE EXCEPTION 'FAIL counter verification';
 EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'Not authorized to verify payments' THEN RAISE; END IF; END;
 INSERT INTO delivery_preferences_qa VALUES('Mostrador no puede verificar una transferencia bancaria','PASS');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',admin_id)::text,true);
 PERFORM public.verify_transfer_payment(payment_id);
 PERFORM public.verify_transfer_payment(payment_id);
 IF NOT EXISTS(SELECT 1 FROM public.sale_payments p WHERE p.id=payment_id AND p.status='received' AND p.verified_by=admin_id AND p.verified_at IS NOT NULL)
 THEN RAISE EXCEPTION 'FAIL admin verification'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Admin verifica transferencia y puede recuperar una respuesta perdida','PASS');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',counter_id)::text,true);
 IF public.record_sale_payment(request_id,sale_id,'transfer',2250,true)<>payment_id THEN RAISE EXCEPTION 'FAIL payment retry'; END IF;
 INSERT INTO delivery_preferences_qa VALUES('Reintento del cobro conserva el mismo pago después de verificación','PASS');
END; $$;

SELECT test,result FROM delivery_preferences_qa ORDER BY test;
ROLLBACK;
