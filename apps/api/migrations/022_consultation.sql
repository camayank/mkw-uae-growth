-- E7D: the consultation an adviser books for a lead. Additive: nullable columns.
alter table leads add column consultation_booked_at timestamptz;
alter table leads add column consultation_booked_for timestamptz;
alter table leads add column consultation_booked_by uuid references users(id);
