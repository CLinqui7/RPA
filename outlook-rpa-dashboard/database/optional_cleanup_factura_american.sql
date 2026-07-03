-- Opcional: limpiar de la vista/base los eventos viejos que NO son Factura American.
-- Primero revisa lo que borraría:
select id, subject, sender_email, created_at
from email_events
where coalesce(subject, '') not ilike '%factura american%'
order by created_at desc
limit 200;

-- Ejecuta esto solo si ya confirmaste que esos eventos viejos no deben vivir en este dashboard.
-- delete from email_events
-- where coalesce(subject, '') not ilike '%factura american%';
