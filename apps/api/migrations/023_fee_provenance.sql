-- E18: each offer line keeps the evidence its government fee was quoted on, so a later change to MKW's fee table never
-- rewrites what the client was told. Additive: nullable columns; a line priced before E18 has no basis and is shown
-- to the client as LEGACY (an estimate), never as verified.
alter table offer_lines
  add column gov_fee_basis text check (gov_fee_basis in ('verified', 'partner_stated', 'uncertain', 'stale')),
  add column gov_fee_id uuid references government_fees(id),
  add column gov_fee_emirate text,
  add column gov_fee_free_zone text,
  add column gov_fee_source_url text,
  add column gov_fee_verified_by text,
  add column gov_fee_verified_at date,
  add column gov_fee_quoted_on date,
  add column gov_fee_review text check (gov_fee_review in ('none', 'required', 'acknowledged')),
  add column gov_fee_ack_by uuid references users(id),
  add column gov_fee_ack_at timestamptz;

-- The quoted fee and its evidence are written once, when the line is priced. The only change allowed afterwards is a
-- person's acknowledgement of a fee that needed one ('required' to 'acknowledged', with who and when, once).
create function offer_lines_fee_evidence_frozen() returns trigger language plpgsql as $$
begin
  if (new.offer_id, new.code, new.qty, new.gov_unit_fils, new.gov_fee_basis, new.gov_fee_id, new.gov_fee_emirate, new.gov_fee_free_zone,
      new.gov_fee_source_url, new.gov_fee_verified_by, new.gov_fee_verified_at, new.gov_fee_quoted_on)
     is distinct from (old.offer_id, old.code, old.qty, old.gov_unit_fils, old.gov_fee_basis, old.gov_fee_id, old.gov_fee_emirate, old.gov_fee_free_zone,
      old.gov_fee_source_url, old.gov_fee_verified_by, old.gov_fee_verified_at, old.gov_fee_quoted_on) then
    raise exception 'A quoted government fee and its evidence are not changed after pricing (E18)';
  end if;
  if new.gov_fee_review is distinct from old.gov_fee_review
     and not (old.gov_fee_review = 'required' and new.gov_fee_review = 'acknowledged' and new.gov_fee_ack_by is not null and new.gov_fee_ack_at is not null) then
    raise exception 'A government fee review moves only from required to acknowledged, by a person (E18)';
  end if;
  if old.gov_fee_ack_at is not null and (new.gov_fee_ack_by, new.gov_fee_ack_at) is distinct from (old.gov_fee_ack_by, old.gov_fee_ack_at) then
    raise exception 'A government fee acknowledgement is not changed once recorded (E18)';
  end if;
  if new.gov_fee_review is distinct from 'acknowledged' and (new.gov_fee_ack_by is not null or new.gov_fee_ack_at is not null) then
    raise exception 'A government fee acknowledgement is recorded only with the review it acknowledges (E18)';
  end if;
  return new;
end $$;
create trigger offer_lines_fee_evidence before update on offer_lines for each row execute function offer_lines_fee_evidence_frozen();

-- An offer line, with its fee evidence, is kept: offers are withdrawn or expire, never deleted.
create function offer_lines_kept() returns trigger language plpgsql as $$
begin
  raise exception 'Offer lines are kept with the evidence they were quoted on (E18)';
end $$;
create trigger offer_lines_no_delete before delete on offer_lines for each row execute function offer_lines_kept();
