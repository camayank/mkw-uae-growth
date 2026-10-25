// Tasees workspace: one page for clients, partners and MKW Advisors staff.
// Plain ES modules, no build step (O12 split the former single file into js/). Every money figure arrives from the
// API in fils (1/100 AED), already filtered by role on the server and in the database; the modules only display it.
//
//   js/core.js        state, API calls, formats, shared components and labels
//   js/shell.js       routing, navigation, sign-in, page chrome, start
//   js/events.js      every click and form action
//   js/common.js      pages every role has (notifications)
//   js/client.js      client home, offer, intake, statement, payments, compliance
//   js/engagement.js  the engagement page (all roles)
//   js/partner.js     partner home, firm, performance, payouts, rate cards
//   js/ops.js         MKW operations: queue, pipeline, offers, delays, dashboard, scoping, AI queue, search
//   js/admin.js       setup: catalogue, rules, people, settings, delivery log
import "./js/events.js";
import "./js/shell.js";
