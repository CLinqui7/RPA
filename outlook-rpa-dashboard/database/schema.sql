create extension if not exists pgcrypto;

create table if not exists public.email_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null default 'outlook_rpa',
  external_key text unique,
  message_type text not null default 'unknown',
  status text not null default 'new',
  subject text,
  sender_name text,
  sender_email text,
  received_at timestamptz,
  snippet text,
  body_text text,
  po_number text,
  customer_name text,
  operator_name text,
  has_attachments boolean default false,
  attachments jsonb default '[]'::jsonb,
  raw jsonb default '{}'::jsonb
);

create index if not exists idx_email_events_created_at on public.email_events(created_at desc);
create index if not exists idx_email_events_status on public.email_events(status);
create index if not exists idx_email_events_po_number on public.email_events(po_number);

create table if not exists public.rpa_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  scanned_count integer default 0,
  inserted_count integer default 0,
  error_message text,
  log jsonb default '[]'::jsonb
);

alter table public.email_events enable row level security;
alter table public.rpa_runs enable row level security;

-- Para MVP con service_role desde backend no necesitas policies.
-- Si luego lees directo desde frontend con anon key, crea policies seguras por usuario/rol.
