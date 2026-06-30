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

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source text not null default 'outlook_rpa',
  external_key text unique,
  email_external_key text,
  subject text,
  sender_name text,
  sender_email text,
  file_name text not null,
  storage_bucket text not null default 'po-documents',
  storage_path text not null,
  file_size bigint,
  sha256 text,
  status text not null default 'downloaded',
  detected_customer text,
  detected_po text,
  ocr_text text,
  raw_json jsonb default '{}'::jsonb,
  raw jsonb default '{}'::jsonb,
  error_message text
);

create index if not exists idx_documents_created_at on public.documents(created_at desc);
create index if not exists idx_documents_status on public.documents(status);
create index if not exists idx_documents_detected_po on public.documents(detected_po);
create index if not exists idx_documents_email_external_key on public.documents(email_external_key);
create index if not exists idx_documents_sha256 on public.documents(sha256);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_documents_updated_at on public.documents;
create trigger trg_documents_updated_at
before update on public.documents
for each row execute function public.set_updated_at();

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
alter table public.documents enable row level security;
alter table public.rpa_runs enable row level security;

-- Para MVP con service_role desde backend no necesitas policies.
-- Si luego lees directo desde frontend con anon key, crea policies seguras por usuario/rol.
-- El backend crea automáticamente el bucket privado definido en INVOICE_STORAGE_BUCKET.
