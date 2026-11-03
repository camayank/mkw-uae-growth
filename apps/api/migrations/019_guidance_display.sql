-- E7A: general guidance notes join rules and places as things the founder approves for public display, one
-- version (a digest of the note's text) at a time. Widens the check constraint only; nothing else changes.
alter table public_approvals drop constraint if exists public_approvals_subject_kind_check;
alter table public_approvals add constraint public_approvals_subject_kind_check check (subject_kind in ('rule', 'place', 'guide'));
