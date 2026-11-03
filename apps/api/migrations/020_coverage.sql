-- E7B Jurisdiction data operations. Additive: new columns, wider checks, one new constraint on new facts only.

-- Classification without double counting: what each place is, and whether it is offered, waiting for figures, or
-- kept for the record only. `active` stays as the engine's switch and follows `status` (the service keeps them in step).
alter table zones add column place_kind text check (place_kind in ('free_zone', 'sub_zone', 'offshore_registry', 'mainland', 'financial_centre', 'industrial_development'));
update zones set place_kind = case type when 'free_zone' then 'free_zone' when 'offshore' then 'offshore_registry' when 'mainland' then 'mainland' when 'financial' then 'financial_centre' end;
alter table zones alter column place_kind set default 'free_zone';
alter table zones alter column place_kind set not null;
alter table zones add column status text not null default 'active' check (status in ('active', 'inactive', 'historical'));
update zones set status = case when active then 'active' else 'inactive' end;
-- The first commercial wave: 1 means verify first; null means no priority set.
alter table zones add column priority smallint check (priority is null or priority between 1 and 9);
-- New evidence the verifier records per place: exact activities, the authority's own charges, conditions, exclusions.
alter table zones add column activity_codes text[];
alter table zones add column gov_charges_min_fils bigint check (gov_charges_min_fils is null or gov_charges_min_fils >= 0);
alter table zones add column gov_charges_max_fils bigint check (gov_charges_max_fils is null or gov_charges_max_fils >= 0);
alter table zones add column conditions text[];
alter table zones add column exclusions text[];

alter table authorities drop constraint if exists authorities_kind_check;
alter table authorities add constraint authorities_kind_check check (kind in ('free_zone_authority', 'mainland_department', 'offshore_registry', 'financial_centre', 'regulator', 'industrial_development'));

-- Each fact can say when the figure takes effect, exactly where in the source it is, and whether the source is the
-- authority itself or an intermediary. An intermediary's figure is labelled as such and can never be verified.
alter table catalogue_facts add column effective_date date;
alter table catalogue_facts add column reference text not null default '';
alter table catalogue_facts add column source_kind text not null default 'official' check (source_kind in ('official', 'intermediary'));
alter table catalogue_facts add constraint catalogue_facts_intermediary check (source_kind = 'official' or confidence <> 'verified');
