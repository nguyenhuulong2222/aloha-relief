-- Aloha Relief schema. Idempotent: safe to run on every boot.

create sequence if not exists donation_ref_seq;
create sequence if not exists request_ref_seq;

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  public_ref text unique not null default ('D-' || lpad(nextval('donation_ref_seq')::text, 4, '0')),
  paypal_order_id text unique not null,
  capture_id text unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  status text not null default 'created'
    check (status in ('created', 'approved', 'captured', 'pending', 'denied', 'refunded')),
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  captured_at timestamptz
  -- Deliberately no donor name or email.
);

create table if not exists requests (
  id uuid primary key default gen_random_uuid(),
  public_ref text unique not null default ('R-' || lpad(nextval('request_ref_seq')::text, 4, '0')),
  need_type text not null
    check (need_type in ('food', 'shelter', 'transport', 'medical', 'utilities', 'other')),
  island text not null
    check (island in ('maui', 'molokai', 'lanai', 'hawaii', 'oahu', 'kauai')),
  amount_cents integer not null,
  description text not null,          -- private: reviewer only
  payee_email text not null,          -- private: reviewer only, used for the payout
  payee_hash text not null,           -- HMAC of normalized email, for duplicate checks
  client_hash text not null,          -- HMAC of IP + user agent, for velocity checks
  lang text not null default 'en' check (lang in ('en', 'vi')),
  status text not null default 'submitted'
    check (status in ('submitted', 'blocked', 'needs_info', 'approved', 'paying', 'paid', 'declined', 'failed')),
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists requests_payee_hash_idx on requests (payee_hash, created_at);
create index if not exists requests_client_hash_idx on requests (client_hash, created_at);

create table if not exists rule_results (
  request_id uuid not null references requests (id) on delete cascade,
  rule_id text not null,
  outcome text not null check (outcome in ('block', 'flag', 'pass')),
  detail text not null,
  created_at timestamptz not null default now(),
  primary key (request_id, rule_id)
);

create table if not exists triage (
  request_id uuid primary key references requests (id) on delete cascade,
  status text not null check (status in ('ok', 'partial', 'failed')),
  failure_reason text,
  prompt_version text not null,
  model text not null,
  input_hash text not null,
  result jsonb,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  cached boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists ai_cache (
  input_hash text primary key,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists ai_usage (
  day date primary key,
  calls integer not null default 0,
  cost_usd numeric(12, 6) not null default 0
);

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests (id),
  decision text not null check (decision in ('approve', 'ask_for_info', 'decline')),
  reviewer_name text not null check (length(trim(reviewer_name)) > 0),
  reason text not null check (length(trim(reason)) >= 3),
  created_at timestamptz not null default now()
);
create unique index if not exists approvals_one_approve on approvals (request_id) where decision = 'approve';

create or replace function approvals_append_only() returns trigger as $$
begin
  raise exception 'approvals are append-only';
end
$$ language plpgsql;

drop trigger if exists approvals_append_only on approvals;
create trigger approvals_append_only before update or delete on approvals
  for each row execute function approvals_append_only();

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid unique not null references requests (id),
  approval_id uuid not null references approvals (id),
  amount_cents integer not null check (amount_cents > 0),
  sender_batch_id text unique not null,
  payout_batch_id text unique,
  payout_item_id text unique,
  status text not null default 'creating'
    check (status in ('creating', 'pending', 'processing', 'succeeded', 'unclaimed', 'held', 'failed', 'returned', 'refunded', 'blocked', 'canceled', 'denied')),
  error_code text,
  is_seed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Human-in-the-loop, enforced by the database too: a payout row can only exist for a request
-- that has an 'approve' decision recorded by a named reviewer, and never for a blocked request.
create or replace function payouts_require_approval() returns trigger as $$
declare
  a approvals%rowtype;
  rule_blocked boolean;
begin
  select * into a from approvals where id = new.approval_id;
  if not found or a.decision <> 'approve' or a.request_id <> new.request_id then
    raise exception 'payout requires an approve decision for this request';
  end if;
  select exists (
    select 1 from rule_results where request_id = new.request_id and outcome = 'block'
  ) into rule_blocked;
  if rule_blocked then
    raise exception 'payout refused: request is blocked by a hard rule';
  end if;
  return new;
end
$$ language plpgsql;

drop trigger if exists payouts_require_approval on payouts;
create trigger payouts_require_approval before insert or update of approval_id, request_id on payouts
  for each row execute function payouts_require_approval();

create table if not exists webhook_events (
  event_id text primary key,
  event_type text not null,
  resource_id text,
  received_at timestamptz not null default now()
);

-- The only thing the public ledger can read. No emails, descriptions, hashes or PayPal IDs.
create or replace view public_ledger as
  select d.public_ref, 'donation'::text as kind, null::text as need_type, null::text as island,
         d.amount_cents, d.status, coalesce(d.captured_at, d.created_at) as at,
         case when d.is_seed then 'seeded' else 'sandbox' end as source
    from donations d
   where d.status in ('captured', 'pending', 'refunded')
  union all
  select r.public_ref, 'grant'::text, r.need_type, r.island,
         p.amount_cents, p.status, p.updated_at,
         case when p.is_seed then 'seeded' else 'sandbox' end
    from payouts p join requests r on r.id = p.request_id;

create table if not exists demo_meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
