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


-- Clients read the links on their own requests (column grants, as for the other columns they may read).
grant select (assessment_id, obligation_id) on requests to app_client;
