-- E23: a contradicting source never changes a figure on its own. Every fact records what it is against the fact that
-- was current when it was recorded (first, same, change or conflict) and why; a conflict waits for the verifier's
-- decision, and the engine keeps the figure it had until then.
alter table catalogue_facts
  add column supersedes_id bigint references catalogue_facts(id),
  add column change_kind text not null default 'change' check (change_kind in ('first', 'same', 'change', 'conflict')),
  add column change_reason text not null default '';
-- Facts recorded before E23: the first per field is 'first', a repeat of the previous value 'same', the rest 'change',
-- in order. None becomes a conflict. The table is append-only for everyone (migration 015); the owner, who runs the
-- migrations, lifts the guard for this one backfill and puts it back (independent review of E23).
alter table catalogue_facts disable trigger catalogue_facts_no_update;
update catalogue_facts f set change_kind = 'first'
  where f.id = (select min(x.id) from catalogue_facts x where x.subject_kind = f.subject_kind and x.subject = f.subject and x.field = f.field);
update catalogue_facts f set supersedes_id = (
  select max(x.id) from catalogue_facts x where x.subject_kind = f.subject_kind and x.subject = f.subject and x.field = f.field and x.id < f.id)
  where f.change_kind = 'change';
update catalogue_facts f set change_kind = 'same'
  where f.change_kind = 'change' and f.value = (select x.value from catalogue_facts x where x.id = f.supersedes_id);
alter table catalogue_facts enable trigger catalogue_facts_no_update;
create index catalogue_facts_conflicts on catalogue_facts (id) where change_kind = 'conflict';

-- The verifier's decision on a conflict: once, never changed. accept: the new figure becomes current; keep: the
-- current one stays.
create table catalogue_fact_reviews (
  fact_id bigint primary key references catalogue_facts(id),
  decision text not null check (decision in ('accept', 'keep')),
  note text not null check (length(note) between 5 and 2000),
  reviewed_by uuid not null references users(id),
  at timestamptz not null default app_now()
);
grant select, insert on catalogue_fact_reviews to app_platform;
alter table catalogue_fact_reviews enable row level security;
create policy catalogue_fact_reviews_platform on catalogue_fact_reviews for all to app_platform using (true) with check (true);
create trigger catalogue_fact_reviews_no_change before update or delete on catalogue_fact_reviews for each row execute function append_only_refuse();
create trigger catalogue_fact_reviews_no_truncate before truncate on catalogue_fact_reviews for each statement execute function append_only_refuse();
