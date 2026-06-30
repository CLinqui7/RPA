-- Patch v14: add size quantity columns needed by exact A2000 lines import.
-- Safe to run multiple times.

alter table public.purchase_order_lines add column if not exists qty_sz2 integer;
alter table public.purchase_order_lines add column if not exists qty_sz3 integer;
alter table public.purchase_order_lines add column if not exists qty_sz4 integer;
alter table public.purchase_order_lines add column if not exists qty_sz5 integer;
alter table public.purchase_order_lines add column if not exists qty_sz6 integer;
alter table public.purchase_order_lines add column if not exists qty_sz7 integer;
alter table public.purchase_order_lines add column if not exists qty_sz8 integer;
alter table public.purchase_order_lines add column if not exists qty_sz9 integer;
alter table public.purchase_order_lines add column if not exists qty_sz10 integer;
alter table public.purchase_order_lines add column if not exists qty_sz11 integer;
alter table public.purchase_order_lines add column if not exists qty_sz12 integer;
alter table public.purchase_order_lines add column if not exists qty_sz13 integer;
alter table public.purchase_order_lines add column if not exists qty_sz14 integer;
alter table public.purchase_order_lines add column if not exists qty_sz15 integer;
alter table public.purchase_order_lines add column if not exists qty_sz16 integer;
alter table public.purchase_order_lines add column if not exists qty_sz17 integer;
alter table public.purchase_order_lines add column if not exists qty_sz18 integer;
