-- O9 Arabic and accessibility: a language per person, the reviewer's sign-off before clients see Arabic.

alter table users add column locale text not null default 'en' check (locale in ('en', 'ar'));
alter table notifications add column locale text not null default 'en';

-- Arabic is a draft until an Arabic speaker the owner names has reviewed it.
insert into settings (key, value) values ('arabic', '{"reviewed": false, "reviewedBy": null, "reviewedAt": null, "note": ""}') on conflict (key) do nothing;

-- People may read their own locale (the column grant on users already lists the public columns).
grant select (locale) on users to app_client, app_partner;
