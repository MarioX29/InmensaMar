-- Consultas de solo lectura para el entorno de prueba.
select id, status, total_cents/100.0 as total_q, created_at
from public.customer_orders order by created_at desc limit 20;

select o.id,o.status,ol.quantity as pedido,
  coalesce(sum(r.quantity) filter (where r.released_at is null),0) as reservado
from public.customer_orders o
join public.customer_order_lines ol on ol.order_id=o.id
left join public.order_reservations r on r.order_line_id=ol.id
group by o.id,o.status,ol.id,ol.quantity order by o.id;

select v.name,l.qty_on_hand,l.qty_reserved
from public.inventory_lots l join public.product_variants v on v.id=l.variant_id
order by v.name,l.received_at;
