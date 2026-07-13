-- A2000 / RPA V4.2
-- Allow one source document to persist 1..N purchase_orders by document_id + order_no.
-- Apply manually in Supabase SQL Editor before running production multi-order persistence.
-- This migration does not touch A2000.

BEGIN;

DO $$
DECLARE
  constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'purchase_orders'
      AND c.contype = 'u'
      AND (
        SELECT array_agg(a.attname ORDER BY keys.ordinality)
        FROM unnest(c.conkey) WITH ORDINALITY AS keys(attnum, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = c.conrelid
         AND a.attnum = keys.attnum
      ) = ARRAY['document_id']::text[]
  LOOP
    EXECUTE format(
      'ALTER TABLE public.purchase_orders DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END $$;

DO $$
DECLARE
  index_name text;
BEGIN
  FOR index_name IN
    SELECT index_class.relname
    FROM pg_index idx
    JOIN pg_class table_class ON table_class.oid = idx.indrelid
    JOIN pg_namespace n ON n.oid = table_class.relnamespace
    JOIN pg_class index_class ON index_class.oid = idx.indexrelid
    WHERE n.nspname = 'public'
      AND table_class.relname = 'purchase_orders'
      AND idx.indisunique
      AND NOT idx.indisprimary
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        WHERE c.conindid = idx.indexrelid
      )
      AND (
        SELECT array_agg(a.attname ORDER BY keys.ordinality)
        FROM unnest(idx.indkey) WITH ORDINALITY AS keys(attnum, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = idx.indrelid
         AND a.attnum = keys.attnum
      ) = ARRAY['document_id']::text[]
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS public.%I', index_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_document_order_uq
  ON public.purchase_orders (document_id, order_no);

COMMIT;

-- Verification: expect exactly one row for purchase_orders_document_order_uq
SELECT
  indexname,
  indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'purchase_orders'
  AND indexname = 'purchase_orders_document_order_uq';
