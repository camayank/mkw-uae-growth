-- E1 Eligibility before recommendation.

-- Cross-border points are their own kind of scoping rule (always a specialist's review, never a conclusion).
alter table scoping_rules drop constraint scoping_rules_kind_check;
alter table scoping_rules add constraint scoping_rules_kind_check check (kind in ('structure', 'zone', 'licence', 'obligation', 'crossborder'));

-- Two facts a place can carry, null meaning "not on record" (the engine says so rather than assuming): the most
-- visas the place allows at all, and its facilities (office, warehouse, industrial, retail).
alter table zones add column visa_max int check (visa_max is null or visa_max >= 0);
alter table zones add column facilities text[];
-- An offshore company sponsors no visas at all: that is the structure, not a package.
update zones set visa_max = 0 where type = 'offshore';
