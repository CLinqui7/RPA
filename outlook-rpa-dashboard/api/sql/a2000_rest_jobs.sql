-- A2000 REST saga / idempotency jobs
-- Run once in Supabase SQL Editor before enabling REST delivery.

create extension if not exists pgcrypto;

create table if not exists public.a2000_rest_jobs (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  source_payload_hash text not null,

  document_id text,
  purchase_order_id text,

  customer_code text not null,
  store_code text not null,
  order_no text not null,
  division_code text not null,

  status text not null default 'preflight_validated'
    check (
      status in (
        'preflight_validated',
        'header_uploading',
        'header_created',
        'lines_uploading',
        'verifying',
        'completed',
        'failed_preflight',
        'failed_header',
        'failed_lines',
        'reconciliation_required',
        'manual_review'
      )
    ),

  a2000_seq_order_no bigint,
  a2000_ctrl_no bigint,

  order_snapshot jsonb,

  header_request jsonb,
  header_response_raw text,
  header_response_json jsonb,

  lines_request jsonb,
  lines_response_raw text,
  lines_response_json jsonb,

  last_error jsonb,

  attempt_count integer not null default 0,

  header_uploaded_at timestamptz,
  lines_uploaded_at timestamptz,
  completed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_a2000_rest_jobs_status
  on public.a2000_rest_jobs(status);

create index if not exists idx_a2000_rest_jobs_purchase_order
  on public.a2000_rest_jobs(purchase_order_id);

create index if not exists idx_a2000_rest_jobs_document
  on public.a2000_rest_jobs(document_id);

create index if not exists idx_a2000_rest_jobs_a2000_seq
  on public.a2000_rest_jobs(a2000_seq_order_no);

comment on table public.a2000_rest_jobs is
  'Persistent A2000 REST saga and idempotency state. Never recreate ORDER_HD after SEQ_ORDER_NO has been persisted.';
