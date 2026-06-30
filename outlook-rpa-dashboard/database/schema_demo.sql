create extension if not exists pgcrypto;

create table if not exists public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  document_id uuid references public.documents(id) on delete set null,
  batch_id uuid,
  source_file_name text,
  parser_name text,
  parser_confidence numeric,
  status text not null default 'needs_mapping',
  customer_raw text,
  customer_code text,
  order_no text,
  order_date date,
  start_date date,
  cancel_date date,
  book_date date,
  dept_raw text,
  dept_code text,
  division_code text,
  store_raw text,
  store_code text,
  terms_raw text,
  terms_code text,
  ship_via_code text,
  warehouse_code text,
  totals jsonb default '{}'::jsonb,
  missing_fields jsonb default '{}'::jsonb,
  conflicts jsonb default '[]'::jsonb,
  raw_json jsonb default '{}'::jsonb,
  unique(document_id)
);

create index if not exists idx_purchase_orders_order_no on public.purchase_orders(order_no);
create index if not exists idx_purchase_orders_status on public.purchase_orders(status);
create index if not exists idx_purchase_orders_batch_id on public.purchase_orders(batch_id);

create table if not exists public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  purchase_order_id uuid references public.purchase_orders(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  order_no text,
  line_no integer,
  customer_sku text,
  ticket_sku text,
  style_raw text,
  style_code text,
  color_raw text,
  color_code text,
  description text,
  size_raw text,
  size_code text,
  sales_price numeric,
  list_price numeric,
  qty_total integer,
  qty_sz1 integer,
  warehouse_code text,
  missing_fields jsonb default '[]'::jsonb,
  raw_json jsonb default '{}'::jsonb
);

create index if not exists idx_purchase_order_lines_order_no on public.purchase_order_lines(order_no);
create index if not exists idx_purchase_order_lines_purchase_order_id on public.purchase_order_lines(purchase_order_id);
create index if not exists idx_purchase_order_lines_style_raw on public.purchase_order_lines(style_raw);

create table if not exists public.a2000_import_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  status text not null default 'generated_demo',
  orders_count integer default 0,
  header_rows_count integer default 0,
  line_rows_count integer default 0,
  header_file_path text,
  lines_file_path text,
  raw_json jsonb default '{}'::jsonb
);

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.a2000_import_batches enable row level security;

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_purchase_orders_updated_at on public.purchase_orders;
create trigger trg_purchase_orders_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();
