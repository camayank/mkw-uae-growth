-- E5 Assessment to Tasees handoff, and renewals as a product. Additive.

-- A request that came from a saved public assessment, or that asks for the renewal an obligation is due for.
alter table requests add column assessment_id uuid references assessments(id);
alter table requests add column obligation_id uuid references obligations(id);
-- One request per saved assessment, whatever two clients do at once. (Whether a renewal is still in flight is decided
-- from the pipeline in the service, not from the request's status, which closes at acceptance.)
create unique index requests_assessment_once on requests (assessment_id) where assessment_id is not null;
create index requests_obligation on requests (obligation_id) where obligation_id is not null;

-- A saved assessment that became a request.
alter table assessments drop constraint assessments_status_check;
alter table assessments add constraint assessments_status_check check (status in ('open', 'lead', 'request', 'anonymised'));

-- The held enquiry that became a request, when ops converted it.
alter table intake_leads add column request_id uuid references requests(id);


-- A renewal request asked for again after its offer expired supersedes the earlier one for the same obligation; the
-- earlier one is retired for good (never priced, quoted or shown as in progress again).
alter table requests add column superseded_by uuid references requests(id);

-- Clients read the links on their own requests (column grants, as for the other columns they may read).
grant select (assessment_id, obligation_id) on requests to app_client;

-- Whether a renewal request is still in flight, decided from its pipeline (a superseded one never is): being scoped or quoted with no accepted
-- offer; holding an offer built but not yet published (draft or in ops review); holding a published offer that has
-- not expired; or delivered by an engagement that is not finished. The request's own status says nothing useful: it
-- reads "offered" from the moment offers are built, closes at acceptance and never moves after an offer expires.
-- SECURITY DEFINER because the client's calendar must know about a draft offer it may not read; the function only
-- answers yes or no about a request the caller can already see.
create function app_renewal_live(req uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from requests r where r.id = req and r.superseded_by is null and (
      (r.status in ('scoped', 'quoting') and not exists (select 1 from offers f where f.request_id = r.id and f.status = 'accepted'))
      or exists (select 1 from offers f where f.request_id = r.id and f.status in ('draft', 'ops_review'))
      or exists (select 1 from offers f where f.request_id = r.id and f.status = 'published' and f.valid_to >= app_now()::date)
      or exists (select 1 from engagements e where e.request_id = r.id and e.status not in ('completed', 'cancelled'))
    )
  )
$$;
