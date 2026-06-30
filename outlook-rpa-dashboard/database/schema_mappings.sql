create extension if not exists pgcrypto;

create table if not exists public.a2000_code_mappings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  customer_raw text,
  customer_code text,
  field_name text not null,
  raw_value text not null,
  a2000_code text,
  confidence numeric default 0.5,
  source text default 'manual',
  notes text,

);

create table if not exists public.a2000_style_color_mappings (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  customer_raw text,
  raw_style text,
  raw_color text,
  customer_sku text,
  a2000_style text,
  a2000_color text,
  upc text,
  division_code text,
  warehouse_code text,
  source text default 'manual',
  notes text
);

create index if not exists idx_a2000_style_color_raw_style on public.a2000_style_color_mappings(raw_style);
create index if not exists idx_a2000_style_color_customer_sku on public.a2000_style_color_mappings(customer_sku);
create index if not exists idx_a2000_code_mappings_field_raw on public.a2000_code_mappings(field_name, raw_value);

create table if not exists public.po_truth_lines (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  customer text,
  folder text,
  export_file text,
  order_no text,
  picktkt text,
  style text,
  color text,
  qty numeric,
  upc text,
  division_code text,
  warehouse_code text,
  raw_json jsonb default '{}'::jsonb
);

create index if not exists idx_po_truth_lines_order_no on public.po_truth_lines(order_no);
create index if not exists idx_po_truth_lines_style_color on public.po_truth_lines(style, color);


create unique index if not exists idx_a2000_code_mappings_unique_expr
on public.a2000_code_mappings (
  field_name,
  raw_value,
  (coalesce(customer_raw, ''))
);
