-- E19: a partner firm reads only the change orders it raised. Before, every party to an engagement could read every
-- change order on it, so one partner firm saw the cost another firm put on its own change order (partner_fils is
-- granted to app_partner). The client keeps reading all of its engagement's change orders (its grant has no partner
-- cost).
drop policy co_party on change_orders;
create policy co_client on change_orders for select to app_client using (app_is_party(engagement_id));
create policy co_partner on change_orders for select to app_partner using (raised_by_org = app_org() and app_is_party(engagement_id));
