-- O3 Payments and invoices: payment links, tax invoices and credit notes, partner invoices, payout runs. Additive.

alter table payments add column pay_url text;
alter table payments add column provider text;
alter table payments add column link_ref text;
alter table payments add column refunded_at timestamptz;
alter table payments add column refund_reference text;

-- MKW's own details for invoices. TRN is UNCERTAIN (null) until the founder enters it; invoices wait for it.
insert into settings (key, value) values ('company', '{
  "legalName": "MKW Advisors",
  "trn": null,
  "address": "",
  "bankName": "", "iban": "", "swift": "",
  "govFeesAsDisbursements": {"value": true, "confidence": "UNCERTAIN", "basis": "Government fees passed through at cost are treated as disbursements outside the scope of VAT; tax adviser to confirm"}
}'::jsonb) on conflict (key) do nothing;

-- Gap-free sequential numbering per year and kind, locked in the issuing transaction.
create table invoice_counters (
  kind text not null check (kind in ('tax_invoice', 'credit_note')),
  year int not null,
  last int not null default 0,
  primary key (kind, year)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('tax_invoice', 'credit_note')),
  number text unique,
  status text not null default 'issued' check (status in ('pending_trn', 'issued')),
  payment_id uuid not null references payments(id),
  engagement_id uuid not null references engagements(id),
  client_org_id uuid not null references orgs(id),
  -- For a credit note: the tax invoice it reverses.
  reverses_invoice_id uuid references invoices(id),
  issued_at timestamptz,
  supply_date date not null default app_now()::date,
  seller jsonb not null,
  buyer jsonb not null,
  lines jsonb not null,
  net_fils bigint not null,
  vat_fils bigint not null,
  disbursements_fils bigint not null default 0,
  gross_fils bigint not null,
  currency text not null default 'AED',
  file_key text,
  created_at timestamptz not null default app_now()
);
create index on invoices (client_org_id, created_at desc);
create index on invoices (payment_id);

-- Partners' own invoices to MKW, one per payout, uploaded before the payout can be released.
create table partner_invoices (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null unique references payouts(id),
  partner_org_id uuid not null references orgs(id),
  number text not null,
  amount_fils bigint not null check (amount_fils >= 0),
  vat_fils bigint not null default 0 check (vat_fils >= 0),
  file_key text not null,
  file_name text not null,
  uploaded_by uuid references users(id),
  uploaded_at timestamptz not null default app_now()
);

-- A weekly batch of payouts: exported as one bank bulk-transfer file, then marked paid by finance.
create table payout_runs (
  id uuid primary key default gen_random_uuid(),
  reference text not null unique,
  status text not null default 'open' check (status in ('open', 'exported', 'paid', 'cancelled')),
  total_fils bigint not null default 0,
  payouts int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default app_now(),
  exported_at timestamptz,
  paid_at timestamptz,
  bank_reference text,
  file_key text
);
alter table payouts add column run_id uuid references payout_runs(id);

-- Grants and row-level security. Clients read their own invoices; partners read their own partner invoices and
-- the run reference on their payouts; nobody but the platform sees runs or counters.
grant all on invoice_counters, invoices, partner_invoices, payout_runs to app_platform;
grant select (id, kind, number, status, payment_id, engagement_id, client_org_id, reverses_invoice_id, issued_at, supply_date, seller, buyer, lines, net_fils, vat_fils, disbursements_fils, gross_fils, currency, created_at) on invoices to app_client;
grant select (id, payout_id, partner_org_id, number, amount_fils, vat_fils, file_name, uploaded_at) on partner_invoices to app_partner;
grant select (run_id) on payouts to app_partner;

alter table invoices enable row level security;
alter table partner_invoices enable row level security;
alter table payout_runs enable row level security;
alter table invoice_counters enable row level security;
create policy invoices_platform on invoices for all to app_platform using (true) with check (true);
create policy invoices_client on invoices for select to app_client using (client_org_id = app_org() and status = 'issued');
create policy partner_invoices_platform on partner_invoices for all to app_platform using (true) with check (true);
create policy partner_invoices_own on partner_invoices for select to app_partner using (partner_org_id = app_org());
create policy payout_runs_platform on payout_runs for all to app_platform using (true) with check (true);
create policy invoice_counters_platform on invoice_counters for all to app_platform using (true) with check (true);

-- A partner may read its own bank details, and nothing else from its profile (scores and checks are MKW's).
create function app_partner_bank() returns jsonb language sql stable security definer set search_path = public as $$
  select profile->'bank' from orgs where id = app_org() and type = 'partner'
$$;
grant execute on function app_partner_bank() to app_partner, app_platform;
