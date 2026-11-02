-- E1 (baseline fix). When a step was approved, and first disputed, on the application clock. Reporting and partner
-- scorecards used to read these from the audit trail, whose timestamps are the database's real clock (as an audit
-- trail must be); mixing the two clocks put steps in the wrong month whenever they differed.
alter table milestones add column approved_at timestamptz;
alter table milestones add column first_disputed_at timestamptz;

update milestones m set approved_at = (
  select max(a.at) from audit_events a
   where a.entity = 'milestone' and a.entity_id = m.id::text and a.action in ('milestone.approved', 'milestone.dispute_approve')
) where m.status = 'client_approved';

update milestones m set first_disputed_at = (
  select min(a.at) from audit_events a where a.entity = 'milestone' and a.entity_id = m.id::text and a.action = 'milestone.disputed'
);

create index milestones_approved_at on milestones (approved_at) where approved_at is not null;
