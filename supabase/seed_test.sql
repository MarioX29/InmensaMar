-- Datos ficticios para pruebas internas. Ejecutar una sola vez en SQL Editor.
-- No usar para inventario o ventas reales.
begin;
insert into public.product_families(name) values ('Camarón'),('Pescado'),('Otros') on conflict(name) do nothing;
insert into public.product_variants(family_id,name,base_unit,price_cents)
select f.id, v.name, v.base_unit, v.price_cents
from (values
 ('Camarón','Camarón entero · Mediano','lb',4500),
 ('Camarón','Camarón pelado · Grande','lb',7500),
 ('Camarón','Cola de camarón','lb',5800),
 ('Pescado','Pescado fresco','lb',3200),
 ('Otros','Mejillones · Paquete','package',3500)
) v(family,name,base_unit,price_cents)
join public.product_families f on f.name=v.family
on conflict(family_id,name) do nothing;
insert into public.inventory_lots(variant_id,qty_received,qty_on_hand,qty_reserved,cost_cents_per_base_unit,status)
select v.id, t.qty, t.qty, 0, t.cost, 'available'
from (values
 ('Camarón entero · Mediano',20::numeric,3000),
 ('Camarón pelado · Grande',12::numeric,5000),
 ('Cola de camarón',10::numeric,4000),
 ('Pescado fresco',18::numeric,2000),
 ('Mejillones · Paquete',14::numeric,2300)
) t(name,qty,cost)
join public.product_variants v on v.name=t.name
where not exists (select 1 from public.inventory_lots l where l.variant_id=v.id);
commit;
