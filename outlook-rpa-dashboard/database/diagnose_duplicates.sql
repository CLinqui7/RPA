-- DIAGNÓSTICO: si Supabase dice duplicate, usualmente es por external_key único.
-- No borra nada. Solo muestra dónde están los posibles duplicados lógicos.

select 'email_events_by_original_external_key' as check_name,
       raw->>'original_external_key' as original_external_key,
       count(*) as rows
from public.email_events
where raw ? 'original_external_key'
group by raw->>'original_external_key'
having count(*) > 1
order by rows desc
limit 50;

select 'documents_by_sha256' as check_name,
       sha256,
       count(*) as rows,
       min(created_at) as first_seen,
       max(created_at) as last_seen
from public.documents
where sha256 is not null
group by sha256
having count(*) > 1
order by rows desc
limit 50;

-- Con patch v20 NO necesitas dropear constraints.
-- La app genera external_key único por corrida y guarda el original en raw.original_external_key.
