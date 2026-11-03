// Browser smoke test: drives one engagement end to end through the web app as client, ops, finance and partners,
// and saves a screenshot of each key screen. Run against a freshly seeded demo server started with DEV_LOGIN=1:
//   pnpm seed && pnpm --filter @tasees/api demo   (in another terminal)
//   npm i -D playwright@1.49.1 && npx playwright install chromium && node scripts/smoke.mjs
// It prints a log and checks that the client never sees partner cost, margin or masked contact details.
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8787";
const OUT = process.env.OUT ?? "./smoke-shots";
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const errors = [];
const log = [];
/** A check that must hold; a failed one fails the run, so CI cannot pass on a leak. */
const check = (label, ok) => {
  log.push(`${label} ${ok ? "OK" : "FAILED"}`);
  if (!ok) errors.push(`check failed: ${label}`);
};
/** A check on a screen that redraws after a request: polls until it holds or 30 s pass, instead of a fixed pause. */
const eventually = async (label, fn, ms = 30000) => {
  const end = Date.now() + ms;
  let ok = false;
  while (!(ok = await fn().catch(() => false)) && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
  check(label, ok);
};

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`${email} console: ${m.text()}`));
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? (d.message().includes("Type ERASE") ? "ERASE" : d.defaultValue() || "REF-12345") : undefined));
  await page.goto(BASE + "/");
  await page.locator(`button[data-email="${email}"]`).click();
  await page.locator('form[data-form="verify"] button[type="submit"]').click();
  await page.waitForSelector("#nav > :is(a, .navgroup)");
  return page;
}
/** Sign in through the real email form (for accounts that are not demo buttons). Development mode fills the code in. */
async function sessionByEmail(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  await page.goto(BASE + "/");
  await page.fill('form[data-form="request-code"] input[name="email"]', email);
  await page.locator('form[data-form="request-code"] button[type="submit"]').click();
  await page.waitForSelector('form[data-form="verify"]');
  await page.locator('form[data-form="verify"] button[type="submit"]').click();
  await page.waitForSelector("#nav > :is(a, .navgroup)");
  return page;
}
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log.push(name);
};
const toastText = async (page) => (await page.locator("#toast").textContent()) ?? "";
/**
 * Whether the toast shows `re` within `ms`: on a slow machine the request can outlast any fixed pause. Polled from
 * here, not with page.waitForFunction, whose in-page polling compiles a string that the app's content security
 * policy (no 'unsafe-eval') refuses.
 */
const toastHas = async (page, re, ms = 30000) => {
  for (const end = Date.now() + ms; ; await page.waitForTimeout(250)) {
    if (re.test(await toastText(page).catch(() => ""))) return true;
    if (Date.now() > end) return false;
  }
};
// axe-core is evaluated through the browser's debugging protocol, which the page's content security policy does not
// govern (the policy still refuses any injected <script>, as it should).
const axeSource = readFileSync(new URL("../node_modules/axe-core/axe.min.js", import.meta.url), "utf8");
const axeResults = [];
async function axeCheck(page, name) {
  if (!(await page.evaluate(() => !!window.axe))) await page.evaluate(axeSource);
  const r = await page.evaluate(async () => {
    const res = await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")) }));
  });
  axeResults.push({ screen: name, violations: r });
  check(`axe: no WCAG 2.1 AA violations on ${name}:`, r.length === 0);
  if (r.length) log.push(`axe ${name}: ${JSON.stringify(r)}`);
}

await (await import("node:fs/promises")).mkdir(OUT, { recursive: true });

// Sign-in screen
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(BASE + "/");
  await p.waitForSelector("form");
  await shot(p, "01-sign-in");
}

// Client: new request
const client = await session("founder@sample-client.test");
await client.goto(BASE + "/#/new");
await client.waitForSelector('form[data-form="intake"]');
// O12: a conversation, one question at a time, with the plan building beside it.
const next = async () => {
  await client.locator('button[data-act="intake-next"]').click();
  await client.waitForTimeout(300);
};
check("the intake asks one question at a time:", (await client.locator("fieldset.q:visible").count()) === 1 && /Question 1 of 6/.test(await client.locator("#intake-count").innerText()));
await next();
check("focus moves to the next question:", await client.evaluate(() => document.activeElement?.tagName === "LEGEND"));
await client.selectOption('select[name="activity"]', "tech");
await client.selectOption('select[name="customers"]', "international");
await client.fill('textarea[name="description"]', "Three partners starting a software company, 2 visas, bank account and VAT registration");
await next();
await client.selectOption('select[name="jurisdiction"]', "free_zone");
await next();
await client.fill('input[name="visas"]', "2");
await next();
await client.check('input[name="extra"][value="BANK-ACC"]');
await client.check('input[name="extra"][value="VAT-RET"]');
await client.fill('input[name="expectedTurnoverAed"]', "500000");
await eventually("the plan builds as the client answers, with no unreviewed advice:", async () => {
  const plan = await client.locator("#intake-plan").innerText();
  return /Free zone licence/.test(plan) && /×2/.test(plan) && /Corporate bank account/.test(plan) && /once a person has checked your answers/.test(plan) && !/recommend|mainland is|you need a/i.test(plan);
});
await shot(client, "02-client-intake");
await next();
check("the last question sums up the answers before anything is sent:", /Software or technology/.test(await client.locator("#intake-summary").innerText()) && (await client.locator('button[data-act="intake-next"]').isHidden()));
await shot(client, "02b-client-intake-review");
await client.locator('form[data-form="intake"] button[type="submit"]').click();
await client.waitForTimeout(800);
log.push("request: " + (await toastText(client)));

// Ops: price and publish
const ops = await session("ops@mkwadvisors.test");
// O13: every change ops sends through the web app, from here to the System page check, should carry an idempotency key.
const opsKeyed = [];
ops.on("request", (r) => {
  if (["POST", "PUT", "DELETE"].includes(r.method()) && r.url().includes("/api/") && !/\/api\/(auth|public)\//.test(r.url())) opsKeyed.push(!!r.headers()["idempotency-key"]);
});
await ops.goto(BASE + "/#/pipeline");
await ops.locator('button[data-act="build"]').first().click();
await ops.waitForTimeout(900);
log.push("build: " + (await toastText(ops)));
await shot(ops, "03-ops-pipeline");
await ops.goto(BASE + "/#/home");
await shot(ops, "04-ops-queue");
// open the standard offer
await ops.goto(BASE + "/#/pipeline");
await ops.waitForSelector('a[href^="#/offer/"]');
const offerLinks = await ops.locator('a[href^="#/offer/"]').evaluateAll((as) => as.map((a) => [a.textContent, a.getAttribute("href")]));
const standard = offerLinks.find(([t]) => t === "standard") ?? offerLinks[0];
await ops.goto(BASE + "/" + standard[1]);
await ops.waitForSelector('button[data-act="publish"]');
await shot(ops, "05-ops-offer-no-margin");
await ops.locator('button[data-act="publish"]').click();
await ops.waitForTimeout(700);
log.push("publish: " + (await toastText(ops)));

// Finance sees margin on the same offer
const finance = await session("finance@mkwadvisors.test");
await finance.goto(BASE + "/" + standard[1]);
await finance.waitForSelector(".kpis");
await shot(finance, "06-finance-offer-with-margin");

// Client: view and accept. The client terms come first (O10): version, draft note, a tick to accept.
await client.goto(BASE + "/" + standard[1]);
await client.waitForSelector('button[data-act="accept-offer"]');
await axeCheck(client, "client offer with the client terms (O10)");
check("client sees the client terms with their version before accepting:", (await client.locator("input[data-terms-version]").count()) === 1 && /version 1/.test(await client.locator(".accept-terms").innerText()));
check("client terms show the draft note until the lawyer's review is recorded:", (await client.getByText("Draft, pending legal review").count()) >= 1);
// O12: the offer reads as a proposal: what we do, how it runs, what it costs and when, the guarantee, the rules.
{
  const proposal = await client.locator("main").innerText();
  check("the offer reads as a proposal with every section:", ["What we will do", "How it will run", "What it costs", "Our guarantee", "Before you accept"].every((h) => proposal.includes(h)));
  check("the proposal states the working-day estimate, the deposit now and the balance later:", /About \d+ working days/.test(proposal) && /On acceptance/.test(proposal) && /When every step is approved/.test(proposal));
  check("the proposal says the rules where the client acts:", /valid until/.test(proposal) && /approved automatically/.test(proposal) && /We do not file returns or notifications/.test(proposal));
  check("the proposal shows no partner cost or margin:", !/partner cost|margin|payout/i.test(proposal));
  // U1: one offer shown as selected, the others as a switch; no tier promises a pace (gap 85).
  if ((await client.locator(".tiers .tier").count()) > 1) check("the offer shows one selected tier and the others as a switch (U1):", (await client.locator(".tiers .tier.best").count()) === 1 && /Switch to/.test(proposal) && !/faster|quicker|sooner/i.test(await client.locator(".tiers").innerText()));
  await shot(client, "72-client-proposal");
}
await client.locator('button[data-act="accept-offer"]').click();
await client.waitForTimeout(300);
await eventually("acceptance without ticking the terms is stopped:", async () => (await toastHas(client, /accept the client terms/i)) && /#\/offer\//.test(client.url()));
await client.locator("input[data-terms-version]").check();
await shot(client, "07-client-offer");
await client.locator('button[data-act="accept-offer"]').click();
await client.waitForURL(/engagement/);
const engagementUrl = client.url();
await client.waitForTimeout(600);
await shot(client, "08-client-engagement-awaiting-payment");
check("client sees a card payment link for the deposit:", (await client.locator('a:text-is("Pay by card")').count()) >= 1);
// O12: the next action is pinned above the timeline: the deposit, with why it matters.
check("the deposit is the pinned next action:", /Pay the deposit: AED/.test(await client.locator(".nextaction").innerText()) && /Work starts when the deposit arrives/.test(await client.locator(".nextaction").innerText()));
check("the timeline runs from acceptance to completion:", /Offer accepted/.test(await client.locator("ol.timeline").innerText()) && /Completed/.test(await client.locator("ol.timeline").innerText()));

// Finance records the deposit
await finance.goto(engagementUrl); await finance.reload();
await finance.waitForSelector('button[data-act="mark-paid"]');
await finance.locator('button[data-act="mark-paid"]').first().click();
await finance.waitForTimeout(900);
log.push("deposit: " + (await toastText(finance)));
await shot(finance, "09-finance-engagement-allocated");

// Partners accept
const partnerPages = [];
for (const email of ["admin@setup-partner.test", "admin@corporate-services.test", "admin@tax-accounts.test"]) {
  const p = await session(email);
  await p.waitForTimeout(500);
  const n = await p.locator('button[data-act="alloc"][data-decision="accept"]').count();
  if (n && !log.some((l) => l.startsWith("shot-partner"))) {
    check("the partner's offer row carries a reply countdown, the payout, and no client price (U1):", /min left|reply time passed/.test(await p.locator("main").innerText()) && /your fees; government fees not included/.test(await p.locator("main").innerText()) && !/client price|margin|clientTotal|AED 0\.00/i.test(await p.locator("main").innerText()));
    await shot(p, "10-partner-offered-work"); log.push("shot-partner");
  }
  for (let i = 0; i < n; i++) {
    await p.locator('button[data-act="alloc"][data-decision="accept"]').first().click();
    await p.waitForTimeout(700);
  }
  log.push(`${email} accepted ${n}`);
  if (n) partnerPages.push(p);
}
// The partner holding the first step uploads evidence and submits it
let worked = false;
for (const p of partnerPages) {
  await p.goto(engagementUrl); await p.reload();
  await p.waitForTimeout(800);
  if (worked || !(await p.locator('form[data-form="evidence"]').count())) continue;
  // U1: the partner's next step is pinned at the top with its evidence form; the steps list below carries no second form.
  const first = p.locator('form[data-form="evidence"]').first();
  // The pinned card holds the open step's form; later steps keep theirs folded in the list, so the page has one visible form.
  check("the partner's next step is pinned with its evidence upload (U1):", (await p.locator(".nextaction h2").count()) === 1 && (await p.locator('.nextaction form[data-form="evidence"]').count()) === 1 && (await p.locator('form[data-form="evidence"]:visible').count()) === 1);
  const types = await first.locator('select[name="type"] option').evaluateAll((os) => os.map((o) => o.value).filter((v) => v !== "other"));
  for (const t of types) {
    await p.locator('form[data-form="evidence"]').first().locator('select[name="type"]').selectOption(t);
    await p.locator('form[data-form="evidence"]').first().locator('input[type="file"]').setInputFiles({ name: `${t}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 demo") });
    await p.locator('form[data-form="evidence"]').first().locator("button").click();
    await p.waitForTimeout(700);
  }
  await p.locator('button[data-act="ms-submit"]').first().click();
  await p.waitForTimeout(700);
  log.push("submit: " + (await toastText(p)));
  await p.fill('textarea[name="body"]', "Please send passport copies. You can reach me on +971 50 123 4567 or ali@example.com");
  await p.locator('form[data-form="message"] button').click();
  await p.waitForTimeout(700);
  const txt = await p.locator("main").innerText();
  check("partner page shows no client price or margin:", !/client price|margin|AED 4,200/i.test(txt));
  await shot(p, "11-partner-engagement");
  worked = true;
}

// Ops QA passes the step
await ops.goto(engagementUrl); await ops.reload();
await ops.waitForSelector('button[data-act="ms-qa"][data-pass="1"]');
await ops.locator('button[data-act="ms-qa"][data-pass="1"]').first().click();
await ops.waitForTimeout(700);
log.push("qa: " + (await toastText(ops)));
await shot(ops, "12-ops-engagement");

// Client approves and sees masked message
await client.goto(engagementUrl); await client.reload();
await client.waitForSelector('button[data-act="ms-review"][data-approve="1"]');
// O12: the step to approve is the pinned action, with the date it is approved on its own.
await eventually("the step waiting for the client is pinned with its automatic approval date:", async () => /approved automatically on/i.test(await client.locator(".nextaction").innerText()) && (await client.locator('.nextaction button[data-act="ms-review"]').count()) === 2);
await shot(client, "73-client-timeline-approve");
// The client approves from the pinned card, where the checked evidence is linked.
check("the pinned card links the evidence MKW checked:", (await client.locator('.nextaction a[href^="/api/evidence/"]').count()) >= 1);
await client.locator('.nextaction button[data-act="ms-review"][data-approve="1"]').click();
await client.waitForTimeout(700);
log.push("approve: " + (await toastText(client)));
const pageText = await client.locator("main").innerText();
check("client page hides the partner's phone and email:", !pageText.includes("123 4567") && !pageText.includes("ali@example.com"));
check("client page shows no partner cost or margin:", !/partner cost|margin/i.test(pageText));
// U1: the next action and messages come first; documents, steps and payments are folding panels with their state in the heading.
check("the client engagement opens on the next action and folds the rest into panels (U1):", (await client.locator("main .nextaction").count()) === 1 && (await client.locator("main details.panel").count()) >= 3 && /Steps/.test(await client.locator("main details.panel[open] > summary").allInnerTexts().then((t) => t.join(" "))) && (await client.evaluate(() => { const a = document.querySelector("main .nextaction"); const t = document.querySelector("main ol.timeline"); return !!a && !!t && !!(a.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); })));
await shot(client, "13-client-engagement-approved");

// Notifications (O2): the client's bell holds the offer and deposit notices; a partner's never says Tasees
await client.goto(BASE + "/#/home"); await client.reload();
await client.waitForSelector("#who .bell");
const unreadBefore = Number((await client.locator("#who .bell .count").textContent().catch(() => "0")) || 0);
check("client bell shows unread notices after the flow:", unreadBefore >= 2);
await client.goto(BASE + "/#/notifications");
await client.waitForSelector('main h1:text-is("Notifications")');
const noticeText = await client.locator("main").innerText();
check("client notifications mention the offers and the deposit:", /offers are ready/i.test(noticeText) && /deposit/i.test(noticeText));
check("client notifications carry no partner cost or margin:", !/partner cost|margin/i.test(noticeText));
await shot(client, "22-client-notifications");
await client.locator('button[data-act="read-all"]').click();
await eventually("mark all as read clears the bell:", async () => (await client.locator("#who .bell .count").count()) === 0);
const partnerNotices = partnerPages[0];
if (partnerNotices) {
  await partnerNotices.goto(BASE + "/#/notifications"); await partnerNotices.reload();
  await partnerNotices.waitForSelector('main h1:text-is("Notifications")');
  const pt = await partnerNotices.locator("main").innerText();
  check("partner notifications come from MKW Advisors and never say Tasees:", /MKW Advisors/.test(pt) && !/tasees/i.test(pt));
  check("partner notifications carry no client price:", !/client price|AED 4,200/i.test(pt));
  await shot(partnerNotices, "23-partner-notifications");
}

// Mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mp = await m.newPage();
await mp.goto(BASE + "/");
await mp.locator('button[data-email="founder@sample-client.test"]').click();
await mp.locator('form[data-form="verify"] button[type="submit"]').click();
await mp.waitForSelector("#nav > :is(a, .navgroup)");
await mp.goto(engagementUrl); await mp.reload();
await mp.waitForTimeout(700);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check("client page at 390 px has no horizontal overflow:", !overflow);
await mp.screenshot({ path: `${OUT}/14-mobile-client.png`, fullPage: false });
await mp.goto(BASE + "/#/notifications"); await mp.reload();
await mp.waitForSelector('main h1:text-is("Notifications")');
await mp.waitForTimeout(500);
check("notifications at 390 px have no horizontal overflow:", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await mp.screenshot({ path: `${OUT}/24-mobile-notifications.png`, fullPage: false });
// O12 at phone width: the home with its pinned action, the conversation, the timeline and the proposal.
for (const [route, name, label, ready] of [
  ["#/", "75-mobile-client-home", "client home with the next action (O12)", ".nextaction"],
  ["#/new", "76-mobile-client-intake", "conversational intake (O12)", "fieldset.q"],
  [engagementUrl.slice(engagementUrl.indexOf("#")), "77-mobile-client-timeline", "client timeline (O12)", "ol.timeline"],
  [standard[1], "78-mobile-client-proposal", "client proposal (O12)", ".proposal"],
]) {
  await mp.goto(BASE + "/" + route); await mp.reload();
  await mp.waitForSelector(ready);
  await mp.waitForTimeout(400);
  check(`${label} at 390 px has no horizontal overflow:`, !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  log.push(name);
  await axeCheck(mp, `${label} at 390 px`);
}
// U1: at phone width the client's and the partner's menus are bottom tab bars; MKW staff keep the grouped menu.
check("the client menu is a bottom tab bar at 390 px (U1):", await mp.evaluate(() => getComputedStyle(document.getElementById("nav")).position === "fixed" && document.querySelectorAll("#nav > a svg").length >= 4));
if (partnerPages.length) {
  const pm = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await partnerPages[0].context().storageState() })).newPage();
  await pm.goto(BASE + "/#/"); await pm.reload();
  await pm.waitForSelector('main h1:text-is("Work from MKW Advisors")');
  await pm.waitForTimeout(500);
  check("the partner menu is a bottom tab bar at 390 px, with no horizontal overflow (U1):", (await pm.evaluate(() => getComputedStyle(document.getElementById("nav")).position === "fixed")) && !(await pm.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await pm.screenshot({ path: `${OUT}/93-mobile-partner-work.png`, fullPage: false });
  log.push("93-mobile-partner-work");
  await axeCheck(pm, "partner work at 390 px (U1)");
  await pm.context().close();
}
await mp.goto(BASE + "/#/statement"); await mp.reload();
await mp.waitForSelector('main h1:text-is("Statement of account")');
await mp.waitForTimeout(500);
check("statement at 390 px has no horizontal overflow:", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await mp.screenshot({ path: `${OUT}/34-mobile-statement.png`, fullPage: false });

// Audit
const founder = await session("founder@mkwadvisors.test");
await founder.goto(BASE + "/#/audit");
await founder.waitForSelector('main h1:text-is("Audit trail")');
check("audit chain intact on the audit screen:", (await founder.locator("main p").first().innerText()).includes("intact"));
await shot(founder, "15-audit");

// People and organisations (O1): partner creation, invite, role change, deactivation, export, erasure
await founder.goto(BASE + "/#/people");
await founder.waitForSelector('form[data-form="new-partner"]');
await shot(founder, "16-people");
const stamp = Date.now().toString(36);
const partnerEmail = `admin-${stamp}@new-partner.test`;
await founder.fill('form[data-form="new-partner"] input[name="name"]', `Smoke Partners ${stamp} LLC`);
await founder.fill('form[data-form="new-partner"] input[name="adminName"]', "Smoke Admin");
await founder.fill('form[data-form="new-partner"] input[name="adminEmail"]', partnerEmail);
await founder.fill('form[data-form="new-partner"] input[name="emirates"]', "Dubai, Sharjah");
await founder.fill('form[data-form="new-partner"] input[name="codes"]', "set-fz-lic, visa-res");
await founder.locator('form[data-form="new-partner"] button[type="submit"]').click();
await founder.waitForTimeout(800);
log.push("partner created: " + (await toastText(founder)));
const newPartnerAdmin = await sessionByEmail(partnerEmail);
log.push("new partner admin signed in, sees: " + (await newPartnerAdmin.locator("#brand").innerText()).replace(/\s+/g, " "));
// Invite staff into the new firm, promote them, then deactivate them
const firmCard = founder.locator(".card", { hasText: `Smoke Partners ${stamp} LLC` });
await firmCard.locator('form[data-form="invite"] input[name="name"]').fill("Smoke Staff");
await firmCard.locator('form[data-form="invite"] input[name="email"]').fill(`staff-${stamp}@new-partner.test`);
await firmCard.locator('form[data-form="invite"] select[name="role"]').selectOption("partner_staff");
await firmCard.locator('form[data-form="invite"] button[type="submit"]').click();
await founder.waitForTimeout(700);
log.push("invite: " + (await toastText(founder)));
const staffRow = founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` });
await staffRow.locator('form[data-form="role"] select').selectOption("partner_admin");
await staffRow.locator('form[data-form="role"] button').click();
await founder.waitForTimeout(700);
log.push("role change: " + (await toastText(founder)));
await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator('button[data-act="user-deactivate"]').click();
await founder.waitForTimeout(700);
log.push("deactivate: " + (await toastText(founder)));
await eventually("deactivated user shows the badge and a reactivate button:", async () => (await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator(".badge.bad").count()) === 1 && (await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator('button[data-act="user-reactivate"]').count()) === 1);
// Export the client member's data (a JSON download), then erase the deactivated staff account
const [download] = await Promise.all([
  founder.waitForEvent("download"),
  founder.locator("tr", { hasText: "accounts@sample-client.test" }).locator('button[data-act="user-export"]').click(),
]);
log.push("export downloaded: " + download.suggestedFilename());
await founder.waitForTimeout(500);
await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator('button[data-act="user-erase"]').click();
await founder.waitForTimeout(800);
log.push("erase: " + (await toastText(founder)));
await eventually("erased person shown as a tombstone:", async () => (await founder.locator("tr", { hasText: "Erased person" }).count()) > 0);
await shot(founder, "17-people-after-changes");
// Ops cannot touch MKW Advisors staff; finance can only look
await ops.goto(BASE + "/#/people"); await ops.reload();
await ops.waitForSelector("main h1");
const mkwCard = ops.locator(".card", { hasText: "MKW Advisors" }).first();
check("ops cannot invite MKW staff or erase anyone:", (await mkwCard.locator('form[data-form="invite"]').count()) === 0 && (await ops.locator('button[data-act="user-erase"]').count()) === 0);
await finance.goto(BASE + "/#/people"); await finance.reload();
await finance.waitForSelector("main h1");
check("finance sees no admin forms or deactivate buttons:", (await finance.locator('form[data-form="invite"], form[data-form="new-partner"], form[data-form="role"]').count()) === 0 && (await finance.locator('button[data-act="user-deactivate"]').count()) === 0);

// Settings: retention periods (O1)
await founder.goto(BASE + "/#/settings");
await founder.waitForSelector('form[data-form="retention"]');
log.push("retention UNCERTAIN badges before: " + (await founder.locator('form[data-form="retention"] .badge:text-is("UNCERTAIN")').count()));
await shot(founder, "18-settings-retention");
// Let every pending render finish first: a late redraw would replace the form and drop the note.
await founder.waitForLoadState("networkidle");
// The note is required: if a late redraw empties it, the browser refuses the submit, so fill and submit until the
// confirmation toast shows (at most three tries), then wait for the re-rendered table.
for (let i = 0; i < 3 && !/Retention periods confirmed/.test(await toastText(founder)); i++) {
  await founder.fill('form[data-form="retention"] input[name="note"]', "Smoke test: confirmed by the founder");
  await founder.locator('form[data-form="retention"] button[type="submit"]').click();
  await toastHas(founder, /Retention periods confirmed/, 10000);
}
log.push("retention: " + (await toastText(founder)));
await eventually("no UNCERTAIN retention badge after the founder confirms:", async () => (await founder.locator('form[data-form="retention"] .badge').count()) > 0 && (await founder.locator('form[data-form="retention"] .badge:text-is("UNCERTAIN")').count()) === 0);
await shot(founder, "19-settings-retention-confirmed");
await finance.goto(BASE + "/#/settings"); await finance.reload();
await finance.waitForSelector("main h1");
check("finance cannot confirm retention periods:", (await finance.locator('form[data-form="retention"] button[type="submit"]').count()) === 0);
const logText = await finance.locator("main").innerText();
check("delivery log lists sent messages for client and partner audiences:", /Delivery log/.test(logText) && /offer ready/i.test(logText) && /allocation offered/i.test(logText));

// Payments and invoices (O3): TRN, held invoice issued, statement and PDF, partner invoice and bank, payout run
await founder.goto(BASE + "/#/settings"); await founder.reload();
await founder.waitForSelector('form[data-form="company"]');
check("invoice held while TRN missing:", /invoice\(s\) held/.test(await founder.locator("main").innerText()));
await founder.fill('form[data-form="company"] input[name="trn"]', "100123456700003");
await founder.fill('form[data-form="company"] input[name="address"]', "Office 1, Dubai, UAE");
await founder.fill('form[data-form="company"] input[name="note"]', "Smoke test: TRN entered");
await founder.locator('form[data-form="company"] button[type="submit"]').click();
await toastHas(founder, /Company details saved/);
log.push("company: " + (await toastText(founder)));
// Saving redraws Settings; a click on the old "Issue" button is lost, so let the redraw settle and retry once.
await founder.waitForLoadState("networkidle");
for (let i = 0; i < 2 && !/TI-\d{4}-000001/.test(await toastText(founder)); i++) {
  await founder.locator('button[data-act="issue-held"]').click({ timeout: 10000 }).catch(() => {});
  await toastHas(founder, /TI-\d{4}-000001/);
}
log.push("issue held: " + (await toastText(founder)));
check("held invoice issued with a sequential number:", /TI-\d{4}-000001/.test(await toastText(founder)));
await shot(founder, "29-settings-company");
await client.goto(BASE + "/#/statement"); await client.reload();
await client.waitForSelector('main h1:text-is("Statement of account")');
const stText = await client.locator("main").innerText();
check("client statement shows the paid deposit and the tax invoice:", /TI-\d{4}-000001/.test(stText) && /Paid to date/.test(stText));
check("client statement carries no partner cost or margin:", !/partner cost|margin|payout/i.test(stText));
const [pdf] = await Promise.all([client.waitForEvent("download"), client.locator('a:text-is("PDF")').first().click()]);
check("client downloads the tax invoice PDF:", /^TI-\d{4}-000001\.pdf$/.test(pdf.suggestedFilename()));
await shot(client, "30-client-statement");
const payoutPartner = partnerPages[0];
await payoutPartner.goto(BASE + "/#/payouts"); await payoutPartner.reload();
await payoutPartner.waitForSelector('form[data-form="bank"]');
await payoutPartner.fill('form[data-form="bank"] input[name="beneficiary"]', "Example Setup Partners FZ-LLC");
await payoutPartner.fill('form[data-form="bank"] input[name="iban"]', "AE07 0331 2345 6789 0123 456");
await payoutPartner.fill('form[data-form="bank"] input[name="bank"]', "Emirates NBD");
await payoutPartner.locator('form[data-form="bank"] button[type="submit"]').click();
await payoutPartner.waitForTimeout(700);
log.push("bank: " + (await toastText(payoutPartner)));
const invForm = payoutPartner.locator('tr:has(.badge:text-is("eligible")) form[data-form="partner-invoice"]').first();
await invForm.locator('input[name="number"]').fill("P-INV-001");
await invForm.locator('input[name="vatAed"]').fill("0");
await invForm.locator('input[type="file"]').setInputFiles({ name: "partner-invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 partner invoice") });
await invForm.locator('button[type="submit"]').click();
await payoutPartner.waitForTimeout(800);
log.push("partner invoice: " + (await toastText(payoutPartner)));
check("partner payouts page shows the invoice number and no client price:", /P-INV-001/.test(await payoutPartner.locator("main").innerText()) && !/client price|margin/i.test(await payoutPartner.locator("main").innerText()));
await shot(payoutPartner, "31-partner-payouts");
await finance.goto(BASE + "/#/partners"); await finance.reload();
await finance.waitForSelector('button[data-act="run-create"]');
check("one payout is ready for the run:", /Create payout run \(1 ready\)/.test(await finance.locator("main").innerText()));
await finance.locator('button[data-act="run-create"]').click();
await finance.waitForTimeout(900);
log.push("run: " + (await toastText(finance)));
const [bankFile] = await Promise.all([finance.waitForEvent("download"), finance.locator('a[data-act-link="run-file"]').first().click()]);
check("finance downloads the bank bulk-transfer file:", /^PR-\d{4}-0001\.csv$/.test(bankFile.suggestedFilename()));
await finance.reload();
await finance.waitForSelector('button[data-act="run-paid"]');
await finance.locator('button[data-act="run-paid"]').click();
await finance.waitForTimeout(900);
log.push("run paid: " + (await toastText(finance)));
await eventually("payout run marked paid:", async () => /paid/.test((await finance.locator("main tbody").last().innerText())));
await shot(finance, "32-finance-payout-runs");
await payoutPartner.goto(BASE + "/#/payouts"); await payoutPartner.reload();
await payoutPartner.waitForSelector("main h1");
check("partner sees the payout released:", (await payoutPartner.locator('.badge:text-is("released")').count()) >= 1);
await ops.goto(BASE + "/#/partners"); await ops.reload();
await ops.waitForSelector("main h1");
check("ops has no payout run controls:", (await ops.locator('button[data-act="run-create"], button[data-act="run-paid"]').count()) === 0);

// Scoping intelligence (O5): ops reviews and approves the advice, the client reads it, AI queue, rules page, public intake
await ops.goto(BASE + "/#/pipeline"); await ops.reload();
await ops.waitForSelector('a[href^="#/request/"]');
check("pipeline flags advice to review:", (await ops.locator('.badge:text-is("advice to review")').count()) >= 1);
const requestHref = await ops.locator('a[href^="#/request/"]').first().getAttribute("href");
await ops.goto(BASE + "/" + requestHref);
await ops.waitForSelector('form[data-form="approve-advice"]');
const scopingText = await ops.locator("main").innerText();
check("ops sees the structure advice with UNCERTAIN labels:", /Structure: Free zone/.test(scopingText) && /UNCERTAIN/.test(scopingText));
// E1: every structure is compared with its eligibility; one the rules exclude cannot be picked.
check("ops sees every structure compared with its eligibility:", /Every structure compared/.test(scopingText) && /(to be verified|does not fit)/.test(scopingText));
check("a structure the rules exclude cannot be chosen at the review:", (await ops.locator('form[data-form="approve-advice"] select[name="structure"] option[disabled]').count()) >= 1);
await shot(ops, "35-ops-scoping-review");
await axeCheck(ops, "ops scoping review with eligibility (E1)");
await ops.locator('input[name="keep"][value="obligation.goaml_dnfbp"]').uncheck().catch(() => {});
await ops.locator('form[data-form="approve-advice"] button[type="submit"]').click();
await ops.waitForTimeout(800);
log.push("advice: " + (await toastText(ops)));
await client.goto(BASE + "/#/home"); await client.reload();
await client.waitForSelector('a[href^="#/request/"]');
await client.locator('a[href^="#/request/"]').first().click();
await client.waitForSelector('main h1:text-is("Our advice for your request")');
const clientAdvice = await client.locator("main").innerText();
check("client sees the approved advice with confidence labels and no money internals:", /Free zone/.test(clientAdvice) && /UNCERTAIN/.test(clientAdvice) && !/margin|partner cost/i.test(clientAdvice));
check("client sees each option's eligibility and why other places do not fit:", /to be verified/.test(clientAdvice) && /Every structure compared/.test(clientAdvice) && /Costs are estimates/.test(clientAdvice));
check("client sees the date the advice's rules and data stand at (E2):", /Rules and place data as of \d/.test(clientAdvice) && /licensed by /.test(clientAdvice));
// U1: two sentences before the reasoning, built from the engine's own labelled text; the full advice folds below, open.
check("the advice opens with a plain summary and the points to confirm before the reasoning (U1):", /fits what you told us|No option fits/.test(await client.locator("main .summary h2").innerText()) && (await client.locator("main .confirm > div").count()) >= 1 && (await client.locator("main .confirm > div").count()) <= 2 && (await client.locator("main details.reasoning[open]").count()) === 1);
// E7D: the reviewed report, as a PDF, from the client's advice page.
check("the client's advice page offers the reviewed report (E7D):", (await client.locator('a[href$="/report.pdf"]').count()) === 1 && /Download the reviewed report/.test(await client.locator("main").innerText()));
{
  const pdf = await client.evaluate(async () => { const r = await fetch(document.querySelector('a[href$="/report.pdf"]').getAttribute("href")); return { type: r.headers.get("content-type"), text: await r.text() }; });
  check("the reviewed report is a PDF naming the reviewer, with every section and no money internals (E7D):", /application\/pdf/.test(pdf.type) && pdf.text.startsWith("%PDF") && /REVIEWED by .+ at MKW Advisors/.test(pdf.text) && /JURISDICTIONS COMPARED/.test(pdf.text) && !/margin|payout/i.test(pdf.text));
}
await shot(client, "36-client-advice");
await axeCheck(client, "client advice with eligibility (E1)");
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await client.context().storageState() });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => errors.push(`E1 mobile: ${e.message}`));
  await m.goto(BASE + "/" + (await client.evaluate(() => location.hash)));
  await m.waitForSelector('main h1:text-is("Our advice for your request")');
  check("client advice at 390 px has no horizontal overflow (E1):", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await m.screenshot({ path: `${OUT}/81-mobile-client-advice.png`, fullPage: true });
  log.push("81-mobile-client-advice");
  await axeCheck(m, "client advice at 390 px (E1)");
  await mctx.close();
}
await ops.goto(BASE + "/#/agent"); await ops.reload();
await ops.waitForSelector('main h1:text-is("AI review queue")');
check("AI queue shows the draft as UNCERTAIN with its lines:", (await ops.locator('form[data-form="draft"]').count()) >= 1 && /software company/.test(await ops.locator("main").innerText()));
await shot(ops, "37-ai-queue");
await ops.locator('form[data-form="draft"] button[value="discard"]').first().click();
await ops.waitForTimeout(700);
log.push("draft: " + (await toastText(ops)));
await founder.goto(BASE + "/#/scoping"); await founder.reload();
await founder.waitForSelector('form[data-form="verify-rule"]');
const ruleForm = founder.locator('form[data-form="verify-rule"][data-id="obligation.vat_mandatory"]');
await ruleForm.locator('select[name="confidence"]').selectOption("verified");
await ruleForm.locator('input[name="verifiedBy"]').fill("A. Qualified, FTA tax agent");
await ruleForm.locator('input[name="sourceUrl"]').fill("https://tax.gov.ae/en/taxes/vat");
await ruleForm.locator('button[type="submit"]').click();
await founder.waitForTimeout(700);
log.push("rule: " + (await toastText(founder)));
await eventually("verified rule shows the verifier:", async () => /A\. Qualified, FTA tax agent/.test(await founder.locator("main").innerText()));
await shot(founder, "38-scoping-rules");
// E2: the jurisdiction catalogue, recording evidence as a fact, and its history.
{
  const main = await founder.locator("main").innerText();
  check("the Scoping page shows the jurisdiction catalogue with its evidence (E2):", /Jurisdiction catalogue/.test(main) && /places offered/.test(main) && /Sharjah Media City/.test(main) && /waiting for figures/.test(main));
  const f = founder.locator('form[data-form="record-fact"]');
  await f.locator('select[name="subject"]').selectOption("place:SHAMS");
  await f.locator('select[name="field"]').selectOption("activities_listed");
  await f.locator('input[name="valueText"]').fill("consulting; tech; ecommerce");
  await f.locator('input[name="sourceUrl"]').fill("https://www.shams.ae/activities");
  await f.locator('select[name="confidence"]').selectOption("verified");
  await f.locator('input[name="verifiedBy"]').fill("A. Qualified, licensing adviser");
  // E7B: the exact reference and the effective date travel with the fact.
  await f.locator('input[name="reference"]').fill("Activities list, page 3");
  await f.locator('input[name="effectiveDate"]').fill("2026-01-01");
  await f.locator('button[type="submit"]').click();
  await founder.waitForTimeout(700);
  log.push("fact: " + (await toastText(founder)));
  await eventually("recorded evidence shows on the place (E2):", async () => /Activity list: consulting, ecommerce, tech/.test(await founder.locator("main").innerText()));
  const row = founder.locator('button[data-act="fact-history"][data-subject="SHAMS"]');
  await row.click();
  const target = await row.getAttribute("data-target");
  await eventually("the place's evidence history opens with the current fact (E2):", async () => /current/.test(await founder.locator(`#${target}`).innerText()) && /A\. Qualified, licensing adviser/.test(await founder.locator(`#${target}`).innerText()));
  check("the history shows the fact's reference and effective date (E7B):", /Activities list, page 3/.test(await founder.locator(`#${target}`).innerText()) && /effective 1 Jan 2026/.test(await founder.locator(`#${target}`).innerText()));
  await shot(founder, "82-scoping-catalogue");
  await axeCheck(founder, "jurisdiction catalogue and evidence history (E2)");
  // E7B: the coverage matrix and the evidence backlog; the founder classifies a place; the backlog downloads.
  await founder.goto(BASE + "/#/coverage"); await founder.reload();
  await founder.waitForSelector('main h1:text-is("Jurisdiction coverage")');
  const cov = await founder.locator("main").innerText();
  check("the Coverage page counts authorities and places once, per emirate and kind, with the backlog first wave first (E7B):", /authorities \(\d+ active\)/.test(cov) && /first-wave places/.test(cov) && /Places by emirate and kind/.test(cov) && /Umm Al Quwain/.test(cov) && /Evidence backlog by place/.test(cov) && /wave 1/.test(cov) && (await founder.locator('form[data-form="place-status"]').count()) >= 15);
  check("the Coverage page lists the public-display approvals outstanding and the expiring evidence (E7B):", /approvals outstanding/.test(cov) && /guide/.test(cov) && /Expiring evidence/.test(cov));
  const csv = await founder.evaluate(async () => (await fetch("/api/admin/coverage/backlog.csv")).text());
  check("the backlog downloads in the importer's layout (E7B):", /^Kind,Place or authority,Field,Value,Source,Evidence date,Confidence/.test(csv) && /^place,KEZAD,cost,,,,/m.test(csv));
  const ps = founder.locator('form[data-form="place-status"][data-id="Fujairah Creative City"]');
  await ps.locator('select[name="status"]').selectOption("historical");
  await ps.locator('button[type="submit"]').click();
  await founder.waitForTimeout(700);
  log.push("place status: " + (await toastText(founder)));
  await eventually("a place marked historical leaves the counts and the backlog (E7B):", async () => /1 historical/.test(await founder.locator("main").innerText()));
  await shot(founder, "96-coverage");
  await axeCheck(founder, "jurisdiction coverage (E7B)");
  const mcov = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await founder.context().storageState() });
  const mc = await mcov.newPage();
  mc.on("pageerror", (e) => errors.push(`coverage mobile: ${e.message}`));
  await mc.goto(BASE + "/#/coverage"); await mc.reload();
  await mc.waitForSelector('main h1:text-is("Jurisdiction coverage")');
  check("the Coverage page at 390 px has no horizontal overflow (E7B):", !(await mc.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mc.screenshot({ path: `${OUT}/97-mobile-coverage.png`, fullPage: false });
  log.push("97-mobile-coverage");
  await axeCheck(mc, "jurisdiction coverage at 390 px (E7B)");
  await mcov.close();
}
// E3: the public Right UAE Entity selector, no sign-in. With nothing approved it shows no rule text and no figure;
// once the founder approves a verified rule and a verified place for public display, those appear.
const pub = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pp = await pub.newPage();
{
  const sel = await pub.newPage();
  sel.on("pageerror", (e) => errors.push(`selector page: ${e.message}`));
  // E7A: the homepage first; the call to action opens the questions, ten for a technology business, in order.
  const answer = async (page, { fromHome = true } = {}) => {
    if (fromHome) {
      await page.goto(BASE + "/selector.html");
      await page.waitForSelector("#landing:not([hidden]) #start");
      await page.locator("#start").click();
    }
    await page.waitForSelector("#questions:not([hidden]) .choice");
    await page.locator('.choice[data-val="tech"]').click(); await page.locator("#next").click();
    await page.locator('.choice[data-val="international"]').click(); await page.locator("#next").click();
    await page.fill("#qnum", "2"); await page.locator("#next").click();
    await page.locator('.choice[data-val="office"]').click(); await page.locator("#next").click();
    await page.fill("#qnum", "30000"); await page.locator("#next").click();
    await page.locator('.choice[data-val="individuals"]').click(); await page.locator("#next").click();
    await page.locator('.choice[data-val="no"]').click(); await page.locator("#next").click();
    await page.waitForSelector("#qnum"); await page.locator("#next").click(); // expected revenue: optional, skipped
    await page.locator('.choice[data-val="not_sure"]').click(); await page.locator("#next").click();
    await page.locator('.choice[data-val="1_month"]').click(); await page.locator("#next").click(); // E7C: when to start, optional
    await page.waitForSelector("#qzone");
    await page.fill("#qzone", "IFZA");
    await page.locator("#next").click();
    await page.waitForSelector("#result:not([hidden]) .card");
    await page.evaluate(() => window.scrollTo(0, 0));
    // The result without the founder's own profile (their budget is their figure, not one of ours).
    return page.evaluate(() => { const r = document.getElementById("result").cloneNode(true); r.querySelector(".profile")?.remove(); document.body.appendChild(r); const t = r.innerText; r.remove(); return t; });
  };
  await sel.goto(BASE + "/selector.html");
  await sel.waitForSelector("#landing:not([hidden]) #start");
  const home = await sel.locator("main").innerText();
  check("the homepage says what is measured, in aggregate, with no cookie (E7C):", /We count how this page is used, in aggregate/.test(home) && /No cookie/.test(home));
  check("the homepage states the product, the call to action, the industries and what it does not do (E7A):", /Find the right UAE entity for your business/.test(home) && /Find the Right UAE Entity/.test(home) && (await sel.locator(".industry").count()) === 7 && /We do not/.test(home) && /Sign in to the Tasees workspace/.test(home) && (await sel.locator("#questions").isHidden()));
  await shot(sel, "95-public-home");
  await axeCheck(sel, "public homepage (E7A)");
  // E8: an industry card opens the quick match at question two (where), with the activity set.
  await sel.locator('.industry[data-activity="manufacturing"]').click();
  await sel.waitForSelector("#quick:not([hidden]) .uaemap .em");
  check("an industry entry opens the quick match at question two with the activity set (E7A, E8):", /Question 2 of 4/i.test(await sel.locator("#quick-step").innerText()) && /Manufacturing/.test(await sel.locator("#quick-answers").innerText()) && (await sel.locator("#quick-track li.done").count()) === 1);
  await sel.locator("#quick-back").click();
  check("going back shows the activity chosen on the industry card (E7A, E8):", (await sel.locator('#quick-step .tile[data-act="manufacturing"]').getAttribute("aria-pressed")) === "true");
  await sel.goto(BASE + "/selector.html");
  await sel.waitForSelector("#landing:not([hidden])");
  await sel.locator('.industry[data-activity="finance"]').click();
  await sel.waitForSelector("#quick:not([hidden]) .tile");
  check("the regulated-finance card keeps question one on screen so virtual assets can be chosen instead (E7A, E8):", /Question 1 of 4/i.test(await sel.locator("#quick-step").innerText()) && (await sel.locator('.tile[data-act="finance"]').getAttribute("aria-pressed")) === "true" && (await sel.locator('.tile[data-act="virtual_assets"]').count()) === 1);
  // E8: the quick match from the homepage, four answers, live counts, and one place to look at first.
  const quickMatch = async (page) => {
    await page.goto(BASE + "/selector.html");
    await page.waitForSelector("#landing:not([hidden]) #quick-start");
    await page.locator("#quick-start").click();
    await page.waitForSelector("#quick:not([hidden]) .tile[data-act]");
    await eventually("the quick match shows the places on record before any answer (E8):", async () => /^\d+$/.test(await page.locator("#quick-count").innerText()));
    await page.locator('.tile[data-act="tech"]').click();
    await page.waitForSelector(".uaemap .em");
    await eventually("each emirate on the map carries its count of places that still fit (E8):", async () => /^\d+$/.test(await page.locator('.em[data-em="Dubai"] .n').innerText()) && (await page.locator(".uaemap .em").count()) === 7 && (await page.locator(".uaemap .em .flag svg").count()) === 7);
    await page.locator('.em[data-em="Dubai"]').click();
    await page.locator("#quick-next").click();
    await page.waitForSelector("#quick-visas");
    await page.locator("#visa-inc").click();
    await page.locator("#quick-next").click();
    await page.waitForSelector("#quick-step [data-band]");
    await eventually("each budget band says how many places fit (E8):", async () => /place\(s\) fit|No place fits yet/.test(await page.locator('[data-band="up_to_25k"]').innerText()));
    await page.locator('[data-band="up_to_25k"]').click();
    await page.locator("#quick-next").click();
    await page.waitForSelector("#quick-step .best");
    await eventually("the quick match names the place to look at first (E8):", async () => (await page.locator("#quick-step .best h3").count()) === 1);
    return page.locator("#quick-step").innerText();
  };
  {
    const q = await quickMatch(sel);
    check("with nothing approved the quick match states no figure, labels the place to be verified and offers the exact price (E8):", /The place to look at first in Dubai/.test(q) && /Price to be verified by a person/.test(q) && !/AED \d/.test(q) && /to be verified by a person/.test(q) && /Preliminary, general information, not advice/.test(q) && /0 of \d+ places that fit have figures checked/.test(q) && (await sel.locator("#quick-price").count()) === 1 && (await sel.locator("#review").isVisible()));
    check("the answers read back with a change link each, and the profile is complete (E8):", /Software or technology/.test(await sel.locator("#quick-answers").innerText()) && /Up to AED 25,000/.test(await sel.locator("#quick-answers").innerText()) && (await sel.locator("#quick-pct").innerText()) === "100%");
    await shot(sel, "103-quick-match-desktop");
    await axeCheck(sel, "quick match result (E8)");
    // Slow answers from the platform (Codex review of E8): a match on its way for new answers never shows the earlier
    // place, and a count still on its way when the founder leaves for the full questions never touches their answers.
    await sel.route("**/api/public/quick", async (r) => { await new Promise((ok) => setTimeout(ok, 1500)); await r.continue(); });
    await sel.locator('#quick-answers button[data-go="4"]').click();
    await sel.locator('[data-band="up_to_50k"]').click();
    await sel.locator("#quick-next").click();
    check("while the match for new answers is on its way, no earlier place, exact-price action or review form is shown (E8):", /Finding your match/.test(await sel.locator("#quick-step").innerText()) && (await sel.locator("#quick-price").count()) === 0 && (await sel.locator("#review").isHidden()));
    await sel.waitForSelector("#quick-step .best h3");
    await sel.locator('#quick-answers button[data-go="4"]').click();
    await sel.locator("#quick-next").click(); // the same answers: the match shows at once and a fresh count is on its way
    await sel.waitForSelector("#quick-full");
    await sel.locator("#quick-full").click();
    await sel.waitForSelector("#questions:not([hidden]) .choice");
    await sel.locator("#back").click();
    await sel.locator('.choice[data-val="trading"]').click();
    await sel.waitForTimeout(2200);
    await sel.locator("#next").click();
    await sel.locator("#back").click();
    check("a count that arrives after the founder left for the full questions does not overwrite their answers (E8):", (await sel.locator('.choice[data-val="trading"]').getAttribute("aria-pressed")) === "true" && (await sel.locator("#quick").isHidden()));
    await sel.unroute("**/api/public/quick");
    await sel.locator("#next").click();
    await sel.waitForSelector("#questions:not([hidden]) .choice");
    await sel.waitForTimeout(600); // a count still on its way must not redraw the quick match over the questions
    check("the full comparison opens at the first question the quick match did not ask, answers kept, with no review form under it (E8):", /Question 2 of 11/.test(await sel.locator("#progress").innerText()) && /Where are your customers/.test(await sel.locator("#qtitle").innerText()) && (await sel.locator("#review").isHidden()) && (await sel.locator("#quick").isHidden()));
    // Phone width: the map becomes a two-column list and nothing scrolls sideways.
    const qp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
    qp.on("pageerror", (e) => errors.push(`quick match phone: ${e.message}`));
    await qp.goto(BASE + "/selector.html");
    await qp.locator("#quick-start").click();
    await qp.locator('.tile[data-act="tech"]').click();
    await qp.waitForSelector(".uaemap .em");
    check("the quick match map at 390 px has no horizontal overflow (E8):", !(await qp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await shot(qp, "104-quick-match-map-phone");
    await axeCheck(qp, "quick match map at 390 px (E8)");
    await quickMatch(qp);
    check("the quick match result at 390 px has no horizontal overflow (E8):", !(await qp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await shot(qp, "105-quick-match-phone");
    await qp.context().close();
  }
  await sel.goto(BASE + "/selector.html");
  await sel.waitForSelector("#landing:not([hidden])");
  const first = await answer(sel);
  check("the result opens with the profile, the legend and the places side by side (E7A):", /Your business profile/.test(first) && /Software or technology/.test(await sel.locator("#result .profile").innerText()) && /What the labels mean|general information/.test(first) && (await sel.locator("#compare table").count()) === 1 && (await sel.locator("#compare thead th").count()) >= 2 && /to be verified by a person/.test(await sel.locator("#compare").innerText()) && !/AED/.test(await sel.locator("#compare").innerText()));
  check("with nothing approved the result shows no general guidance and names the next action (E7A):", (await sel.locator(".guide").count()) === 0 && /Ask MKW Advisors to review this result/.test(first));
  check("the selector answers without sign-in and labels the result preliminary (E3):", /Preliminary, general information, not advice/.test(first) && /IFZA/.test(first));
  check("with nothing approved the selector shows no rule text and no figure (E3):", !/AED /.test(first) && /0 of \d+ statements and 0 of \d+ places/.test(first) && /to be verified by a person/.test(first) && !/Register for corporate tax/.test(first));
  await shot(sel, "83-public-selector-unapproved");
  await axeCheck(sel, "public selector result, nothing approved (E3)");
  // The founder approves the corporate tax rule (verified earlier in this run? no: VAT was) and IFZA's figures.
  await founder.goto(BASE + "/#/scoping"); await founder.reload();
  await founder.waitForSelector('form[data-form="verify-rule"]');
  const ct = founder.locator('form[data-form="verify-rule"][data-id="obligation.corporate_tax"]');
  await ct.locator('select[name="confidence"]').selectOption("verified");
  await ct.locator('input[name="verifiedBy"]').fill("A. Qualified, tax agent");
  await ct.locator('input[name="sourceUrl"]').fill("https://tax.gov.ae/en/taxes/corporate-tax");
  await ct.locator('button[type="submit"]').click();
  await founder.waitForTimeout(700);
  const zf = founder.locator('form[data-form="verify-zone"][data-id="IFZA"]');
  await zf.locator('select[name="confidence"]').selectOption("verified");
  await zf.locator('input[name="verifiedBy"]').fill("A. Qualified, licensing adviser");
  await zf.locator('input[name="sourceUrl"]').fill("https://ifza.com/");
  await zf.locator('button[type="submit"]').click();
  await founder.waitForTimeout(700);
  await founder.locator('button[data-act="display-approve"][data-kind="rule"][data-subject="obligation.corporate_tax"]').click();
  await founder.waitForTimeout(700);
  log.push("public rule: " + (await toastText(founder)));
  await founder.locator('button[data-act="display-approve"][data-kind="place"][data-subject="IFZA"]').click();
  await founder.waitForTimeout(700);
  log.push("public place: " + (await toastText(founder)));
  await eventually("the Scoping page counts what the public may see (E3):", async () => /1 \/ \d+\s+rules the public selector may show/.test(await founder.locator("main").innerText()));
  {
    // E8: the approved place's figures reach the quick match too, labelled checked; the others stay to be verified.
    const q = await quickMatch(sel);
    check("an approved place's figures reach the quick match, labelled checked (E8):", /AED 12,000/.test(q + (await sel.locator("#quick-top").innerText())) && /figures checked|from AED 12,000/.test(q + (await sel.locator("#quick-top").innerText())) && /1 of \d+ places that fit have figures checked/.test(q));
  }
  const second = await answer(sel);
  check("an approved rule and place reach the public with text and figures (E3):", /Register for corporate tax/.test(second) && /AED 12,000 to AED 20,000 to set up/.test(second) && /figures checked/.test(second));
  check("everything else stays to be verified (E3):", /to be verified by a person/.test(second) && /1 of \d+ statements and 1 of \d+ places/.test(second));
  // E7A: the comparison table carries the approved place's figures and source, the rest to be verified; the founder
  // approves one guidance note and the selector shows it, labelled general information; an answer can be changed.
  const cmp = await sel.locator("#compare").innerText();
  check("the side-by-side table shows the approved place's figures, three-year estimate and source, and nothing for the rest (E7A):", /AED 12,000 to AED 20,000/.test(cmp) && /Three-year estimate\s+needs the yearly renewal on record/i.test(cmp) && (await sel.locator('#compare a[href^="https://ifza.com"]').count()) === 1 && /to be verified by a person/.test(cmp) && (await sel.locator("#compare thead th").count()) >= 3);
  await founder.locator('button[data-act="display-approve"][data-kind="guide"][data-subject="reading.labels"]').click();
  await founder.waitForTimeout(700);
  log.push("public guide: " + (await toastText(founder)));
  await eventually("the Scoping page counts the guidance note the public may read (E7A):", async () => /1 \/ \d+\s+guidance notes the public may read/.test(await founder.locator("main").innerText()));
  await sel.locator("#edit").click();
  await sel.waitForSelector("#questions:not([hidden]) .choice");
  check("changing the answers keeps them (E7A):", (await sel.locator('.choice[data-val="tech"]').getAttribute("aria-pressed")) === "true" && /Question 1 of 11/.test(await sel.locator("#progress").innerText()));
  const third = await answer(sel, { fromHome: false });
  check("an approved guidance note reaches the public, labelled general information, with no figure in it (E7A):", (await sel.locator(".guide").count()) === 1 && /How to read this result/.test(third) && /general information/.test(await sel.locator(".guide").innerText()) && !/\d/.test(await sel.locator(".guide p").innerText()));
  await shot(sel, "84-public-selector-approved");
  await axeCheck(sel, "public selector result, one rule and one place approved (E3)");
  // E4: the founder saves the result and gets a code; a new page recovers it; the review request carries the
  // session, the optional consents (left unticked) and a call request, and becomes a lead in the pipeline.
  await sel.locator("#save").click();
  await eventually("saving the result returns a recovery code (E4):", async () => /Saved: code [A-Z2-9]{10}/.test(await sel.locator("#save").innerText()));
  const savedCode = (await sel.locator("#save").innerText()).match(/[A-Z2-9]{10}/)[0];
  {
    // E7D: the preliminary report for the saved result, as a PDF, labelled preliminary, with the approved place's figures.
    const pdf = await sel.evaluate(async (code) => { const r = await fetch(`/api/public/assessments/${code}/report.pdf`); return { type: r.headers.get("content-type"), text: await r.text() }; }, savedCode);
    check("the preliminary report downloads as a PDF with the label, the sections and only approved figures (E7D):", /application\/pdf/.test(pdf.type) && pdf.text.startsWith("%PDF") && /PRELIMINARY: general information/.test(pdf.text) && /YOUR BUSINESS PROFILE/.test(pdf.text) && /AED 12,000 to AED 20,000 \[CHECKED\]/.test(pdf.text) && /\[TO BE VERIFIED\]/.test(pdf.text) && !/margin|payout/i.test(pdf.text) && (await sel.locator("#report").count()) === 1);
  }
  const rec = await pub.newPage();
  rec.on("pageerror", (e) => errors.push(`selector recover: ${e.message}`));
  await rec.goto(BASE + `/selector.html?code=${savedCode}`);
  await rec.waitForSelector("#result:not([hidden]) .card");
  check("a saved result is recovered by its code and re-run on today's rules (E4):", /opened 1 time/.test(await rec.locator("#result").innerText()) && /Register for corporate tax/.test(await rec.locator("#result").innerText()));
  await rec.close();
  check("the optional consents start unticked (E4):", !(await sel.locator('#review input[name="marketing"]').isChecked()) && !(await sel.locator('#review input[name="partner"]').isChecked()));
  await sel.fill("#company", "Selector Smoke Co");
  await sel.fill("#name", "Selector Founder");
  await sel.fill("#email", `selector-${stamp}@smoke.test`);
  await sel.check("#call");
  await sel.fill("#times", "weekday mornings");
  await sel.check('#review input[name="consent"]');
  await sel.locator('#review button[type="submit"]').click();
  await eventually("the selector's review request is accepted (E3):", async () => /A person at MKW Advisors reviews your case/.test(await sel.locator("#rmsg").innerText()));
  await ops.goto(BASE + "/#/leads"); await ops.reload();
  await ops.waitForSelector('main h1:text-is("Leads")');
  const leadsText = await ops.locator("main").innerText();
  check("the lead appears in the pipeline with its scores, consents and call request (E4):", /Selector Smoke Co/.test(leadsText) && /call requested/.test(leadsText) && /marketing: no/.test(leadsText) && /service: yes/.test(leadsText));
  await shot(ops, "86-leads-pipeline");
  await axeCheck(ops, "leads pipeline (E4)");
  await ops.locator('a[href^="#/leads/"]').first().click();
  await ops.waitForSelector('form[data-form="lead-followup"]');
  await ops.locator('form[data-form="lead-status"] select[name="status"]').selectOption("contacted");
  await ops.locator('form[data-form="lead-status"] input[name="note"]').fill("Called; sending the comparison");
  await ops.locator('form[data-form="lead-status"] button[type="submit"]').click();
  await ops.waitForTimeout(700);
  log.push("lead status: " + (await toastText(ops)));
  await eventually("the lead's status change is recorded in its history (E4):", async () => /new → contacted: Called; sending the comparison/.test(await ops.locator("main").innerText()));
  // E7C: the lead carries the evidence behind its scores and a next best action; the adviser overrides it with a reason.
  const leadPage = await ops.locator("main").innerText();
  check("the lead page shows purchase readiness and commercial value with their evidence, and the next best action with its reason (E7C):", /Purchase readiness \d+/.test(leadPage) && /Commercial value \d+/.test(leadPage) && /Base 10 plus/.test(leadPage) && /asked for a call/.test(leadPage) && /Wants to start\s+within a month/.test(leadPage) && /Next best action: /.test(leadPage) && (await ops.locator('form[data-form="lead-next-action"]').count()) === 1);
  await ops.locator('form[data-form="lead-next-action"] input[name="action"]').fill("Wait for their documents");
  await ops.locator('form[data-form="lead-next-action"] input[name="reason"]').fill("Travelling until the 20th");
  await ops.locator('form[data-form="lead-next-action"] button[type="submit"]').click();
  await ops.waitForTimeout(700);
  log.push("next action: " + (await toastText(ops)));
  await eventually("the override shows beside the rule's suggestion (E7C):", async () => /Set by hand: Travelling until the 20th/.test(await ops.locator("main").innerText()) && /The rule suggests:/.test(await ops.locator("main").innerText()));
  await shot(ops, "87-lead-detail");
  await axeCheck(ops, "lead detail (E4)");
  await ops.goto(BASE + "/#/funnel"); await ops.reload();
  await ops.waitForSelector('main h1:text-is("Funnel")');
  const funnel = await ops.locator("main").innerText();
  check("the Funnel page counts the selector's visits, starts, completions and saves and follows them to the lead (E7C):", /visitors/.test(funnel) && /completed of started/.test(funnel) && /By source and campaign/.test(funnel) && /direct/.test(funnel) && /Qualified means/.test(funnel) && !/payout|partner cost|AED [\d,]+ margin/i.test(funnel) && /\bdirect\s+–\s+[1-9]/.test(await ops.locator("main").innerText()));
  check("the Funnel page lists the high-readiness lead that needs a person (E7C):", /Selector Smoke Co/.test(funnel) && /unassigned|overdue|no contact/.test(funnel));
  await shot(ops, "98-funnel");
  await axeCheck(ops, "funnel (E7C)");
  {
    const mfc = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ops.context().storageState() });
    const mf = await mfc.newPage();
    await mf.goto(BASE + "/#/funnel"); await mf.reload();
    await mf.waitForSelector('main h1:text-is("Funnel")');
    check("the Funnel page at 390 px has no horizontal overflow (E7C):", !(await mf.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
    await mf.screenshot({ path: `${OUT}/99-mobile-funnel.png`, fullPage: false });
    log.push("99-mobile-funnel");
    await axeCheck(mf, "funnel at 390 px (E7C)");
    await mfc.close();
  }
  // E7D: the adviser books the call from the lead page; the lead moves to consultation with a follow-up for that time.
  await ops.goto(BASE + "/#/leads"); await ops.reload();
  await ops.waitForSelector('main h1:text-is("Leads")');
  await ops.locator('a[href^="#/leads/"]').first().click();
  await ops.waitForSelector('form[data-form="lead-consultation"]');
  await ops.locator('form[data-form="lead-consultation"] input[name="at"]').fill("2027-01-12T10:30");
  await ops.locator('form[data-form="lead-consultation"] input[name="note"]').fill("Teams link in the calendar");
  await ops.locator('form[data-form="lead-consultation"] button[type="submit"]').click();
  await ops.waitForTimeout(700);
  log.push("booking: " + (await toastText(ops)));
  await eventually("the call is booked: the lead is in consultation with a follow-up for that time (E7D):", async () => /Booked for 12 Jan, \d\d:\d\d GST/.test(await ops.locator("main").innerText()) && /Call booked for/.test(await ops.locator("main").innerText()));
  await shot(ops, "101-lead-booked");
  await axeCheck(ops, "lead page with the call booked (E7D)");

  const mlead = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ops.context().storageState() });
  const ml = await mlead.newPage();
  ml.on("pageerror", (e) => errors.push(`leads mobile: ${e.message}`));
  await ml.goto(BASE + "/#/leads"); await ml.reload();
  await ml.waitForSelector('main h1:text-is("Leads")');
  check("the leads page at 390 px has no horizontal overflow (E4):", !(await ml.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await ml.screenshot({ path: `${OUT}/88-mobile-leads.png`, fullPage: false });
  log.push("88-mobile-leads");
  // E7D: the booked lead at phone width.
  await ml.locator('a[href^="#/leads/"]').first().click();
  await ml.waitForSelector('form[data-form="lead-consultation"]');
  check("the lead page at 390 px has no horizontal overflow (E7D):", !(await ml.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await ml.screenshot({ path: `${OUT}/102-mobile-lead-booked.png`, fullPage: true });
  log.push("102-mobile-lead-booked");
  await mlead.close();
  const m3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mp = await m3.newPage();
  mp.on("pageerror", (e) => errors.push(`selector mobile: ${e.message}`));
  await mp.goto(BASE + "/selector.html");
  await mp.waitForSelector("#landing:not([hidden]) #start");
  check("the homepage at 390 px has no horizontal overflow (E7A):", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp.screenshot({ path: `${OUT}/94-mobile-public-home.png`, fullPage: true });
  log.push("94-mobile-public-home");
  await axeCheck(mp, "public homepage at 390 px (E7A)");
  await answer(mp);
  check("the selector result at 390 px has no horizontal overflow (E3):", !(await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp.screenshot({ path: `${OUT}/85-mobile-public-selector.png`, fullPage: true });
  log.push("85-mobile-public-selector");
  await axeCheck(mp, "public selector at 390 px (E3)");
  await m3.close();
  await sel.close();
}
pp.on("pageerror", (e) => errors.push(`intake page: ${e.message}`));
await pp.goto(BASE + "/intake.html?utm_campaign=smoke");
// The public page keeps its own single column: the app's styles must not reach it (O12 review).
check("the public intake page keeps its single-column layout:", await pp.evaluate(() => { const m = document.querySelector("main.intake"); return !!m && getComputedStyle(m).display !== "grid" && m.getBoundingClientRect().width <= 780; }));
await pp.fill("#company", "Smoke Lead Ventures");
await pp.fill("#name", "Smoke Lead");
await pp.fill("#email", `lead-${stamp}@smoke.test`);
await pp.selectOption("#activity", "consulting");
await pp.selectOption("#customers", "international");
await pp.check('input[name="consent"]');
await shot(pp, "39-public-intake");
await pp.locator('button[type="submit"]').click();
await pp.waitForTimeout(1200);
await eventually("public intake accepted the lead:", async () => /Thank you. We have your request/.test(await pp.locator("#msg").innerText()));
await ops.goto(BASE + "/#/pipeline"); await ops.reload();
await ops.waitForSelector("main h1");
check("lead from the public page appears in the pipeline:", /Smoke Lead Ventures/.test(await ops.locator("main").innerText()) && /from the lead page/.test(await ops.locator("main").innerText()));
await ops.fill('form[data-form="search"] input[name="q"]', "smoke lead");
await ops.locator('form[data-form="search"] input[name="q"]').press("Enter");
await ops.waitForSelector('main h1:text-is("Search: smoke lead")');
check("search finds the new client:", /Smoke Lead Ventures/.test(await ops.locator("main").innerText()));
// The same email again from the public page: held for a person, never attached to the account.
await pp.goto(BASE + "/intake.html");
await pp.fill("#company", "Second Try Co");
await pp.fill("#name", "Smoke Lead");
await pp.fill("#email", `lead-${stamp}@smoke.test`);
await pp.check('input[name="consent"]');
await pp.locator('button[type="submit"]').click();
await pp.waitForTimeout(1200);
await eventually("repeat lead gets the same answer:", async () => /Thank you. We have your request/.test(await pp.locator("#msg").innerText()));
await ops.goto(BASE + "/#/agent"); await ops.reload();
await ops.waitForSelector('main h1:text-is("AI review queue")');
check("repeat lead is held for ops, not attached:", /Held leads/.test(await ops.locator("main").innerText()) && /Second Try Co/.test(await ops.locator("main").innerText()));
await shot(ops, "42-held-leads");
await ops.fill('form[data-form="lead"] input[name="note"]', "Duplicate of the first lead");
await ops.locator('form[data-form="lead"] button[type="submit"]').click();
await ops.waitForTimeout(600);
check("held lead marked handled:", !/Second Try Co/.test(await ops.locator("main").innerText()));
// E5: a held enquiry becomes a request for the existing client on ops' action.
await pp.goto(BASE + "/intake.html");
await pp.fill("#company", "Third Try Co");
await pp.fill("#name", "Smoke Lead");
await pp.fill("#email", `lead-${stamp}@smoke.test`);
await pp.selectOption("#activity", "trading");
await pp.selectOption("#customers", "uae_mainland");
await pp.check('input[name="consent"]');
await pp.locator('button[type="submit"]').click();
await pp.waitForTimeout(1200);
await ops.goto(BASE + "/#/agent"); await ops.reload();
await ops.waitForSelector('button[data-act="lead-convert"]');
await ops.locator('button[data-act="lead-convert"]').first().click();
await ops.waitForSelector('form[data-form="approve-advice"], h1:text-is("Scoping")', { timeout: 8000 }).catch(() => {});
await eventually("ops turned the held enquiry into a request for the existing client (E5):", async () => /Scoping/.test(await ops.locator("main h1").innerText()) && /trading/.test(await ops.locator("main").innerText()));
await shot(ops, "89-held-enquiry-converted");

// Catalogue and rules (O4)
await founder.goto(BASE + "/#/catalogue");
await founder.waitForSelector('main h1:text-is("Service catalogue")');
check("catalogue lists 82 services:", (await founder.locator("main tbody tr").count()) === 82);
await shot(founder, "25-catalogue");
await founder.goto(BASE + "/#/rules");
await founder.waitForSelector('main h1:text-is("Pricing rules and government fees")');
await founder.selectOption('form[data-form="fee"] select[name="code"]', "SET-FZ-LIC");
await founder.selectOption('form[data-form="fee"] select[name="emirate"]', "Dubai");
await founder.fill('form[data-form="fee"] input[name="freeZone"]', "IFZA");
await founder.fill('form[data-form="fee"] input[name="feeAed"]', "8900");
await founder.fill('form[data-form="fee"] input[name="sourceUrl"]', "https://example.gov.ae/fees");
await founder.fill('form[data-form="fee"] input[name="sourceNote"]', "Smoke test row");
await founder.locator('form[data-form="fee"] button[type="submit"]').click();
await founder.waitForTimeout(700);
log.push("fee: " + (await toastText(founder)));
await eventually("new fee shows as UNCERTAIN:", async () => (await founder.locator('.badge:text-is("UNCERTAIN")').count()) >= 1 && (await founder.locator("main").innerText()).includes("IFZA"));
await founder.locator('button[data-act="fee-verify"]').first().click();
await founder.waitForTimeout(700);
log.push("verify: " + (await toastText(founder)));
check("verified fee shows the verifier and no stale badge:", (await founder.locator("main tbody").last().innerText()).includes("REF-12345") && (await founder.locator('.badge:text-is("stale")').count()) === 0);
const otherRow = founder.locator('form[data-form="rule"][data-id="Other"]');
await otherRow.locator('input[name="ratePct"]').fill("22");
await otherRow.locator('input[name="floorAed"]').fill("350");
await otherRow.locator('input[name="effectiveFrom"]').fill("2030-01-01");
await otherRow.locator('input[name="note"]').fill("Smoke test schedule");
await otherRow.locator('button[type="submit"]').click();
await founder.waitForTimeout(700);
log.push("rule: " + (await toastText(founder)));
await eventually("scheduled rule change is listed with its date:", async () => /22\.0%.*AED 350.*from 1 Jan 2030/s.test(await founder.locator("main").innerText()));
await shot(founder, "26-rules");
await ops.goto(BASE + "/#/rules"); await ops.reload();
await ops.waitForSelector('main h1:text-is("Government fees")');
const opsRules = await ops.locator("main").innerText();
check("ops sees the fee table but no margin rates, floors or settings:", !/Margin rules by category|Pricing settings|20\.0%/.test(opsRules) && (await ops.locator('form[data-form="rule"], form[data-form="pricing-settings"], button[data-act="fee-verify"]').count()) === 0 && (await ops.locator('form[data-form="fee"]').count()) === 1);
await ops.goto(BASE + "/#/catalogue"); await ops.reload();
await ops.waitForSelector('main h1:text-is("Service catalogue")');
check("ops catalogue hides the rule column values:", !/20\.0% \//.test(await ops.locator("main").innerText()));

// Partners and delivery (O6): onboarding with documents, client document requests, delays page, offer PDF
const pdfBytes = Buffer.from("%PDF-1.4 smoke");
await founder.goto(BASE + "/#/partners"); await founder.reload();
await founder.waitForSelector('main h1:text-is("Partner network")');
const firmLink = founder.locator("main a", { hasText: `Smoke Partners ${stamp} LLC` }).first();
check("partners page links to onboarding:", (await firmLink.count()) === 1);
await firmLink.click();
await founder.waitForSelector('form[data-form="partner-move"]');
await shot(founder, "43-ops-partner-onboarding");
await founder.selectOption('form[data-form="partner-move"] select[name="status"]', "contacted");
await founder.fill('form[data-form="partner-move"] input[name="note"]', "Intro call done");
await founder.locator('form[data-form="partner-move"] button[type="submit"]').click();
await founder.waitForTimeout(700);
await eventually("partner moved to contacted:", async () => /contacted/i.test(await founder.locator("main .badge").first().innerText()));
// The new partner's admin completes the application and uploads the trade licence
await newPartnerAdmin.goto(BASE + "/#/firm"); await newPartnerAdmin.reload();
await newPartnerAdmin.waitForSelector('form[data-form="application"]');
await newPartnerAdmin.fill('form[data-form="application"] input[name="licenceNumber"]', "DED-SMOKE-1");
await newPartnerAdmin.fill('form[data-form="application"] input[name="licenceExpiry"]', "2027-12-31");
await newPartnerAdmin.check('form[data-form="application"] input[name="emirates"][value="Dubai"]');
await newPartnerAdmin.locator('form[data-form="application"] button[type="submit"]').click();
await newPartnerAdmin.waitForTimeout(800);
await eventually("application submitted:", async () => (await toastHas(newPartnerAdmin, /Application saved/)) && /applied/i.test(await newPartnerAdmin.locator("main .badge").first().innerText()));
await newPartnerAdmin.selectOption('form[data-form="partner-doc"] select[name="kind"]', "trade_licence");
await newPartnerAdmin.fill('form[data-form="partner-doc"] input[name="expiresOn"]', "2027-12-31");
await newPartnerAdmin.setInputFiles('form[data-form="partner-doc"] input[name="file"]', { name: "trade-licence.pdf", mimeType: "application/pdf", buffer: pdfBytes });
await newPartnerAdmin.locator('form[data-form="partner-doc"] button[type="submit"]').click();
await newPartnerAdmin.waitForTimeout(800);
await eventually("trade licence uploaded, awaiting MKW check:", async () => /awaiting MKW check/.test(await newPartnerAdmin.locator("main").innerText()));
await shot(newPartnerAdmin, "44-partner-firm");
// O11 command centre: the licence waits in the ranked queue with why it is there and the document check beside it.
await ops.goto(BASE + "/#/home"); await ops.reload();
await ops.waitForSelector("#queue-list");
await eventually("command centre says why the partner document is waiting:", async () => /a firm cannot move to pilot, or keep working, on an unverified document/.test(await ops.locator("#queue-list").innerText()));
const licenceItem = ops.locator(".qitem", { hasText: "Partner document to verify: trade licence" });
await eventually("the document check sits beside it, UNCERTAIN, read from the name only:", async () => {
  const t = await licenceItem.innerText();
  return /The file looks like a trade licence/.test(t) && /UNCERTAIN/.test(t) && /file itself was not read/.test(t);
});
check("every queue item says why it is ranked where it is:", (await ops.locator(".qitem").count()) > 0 && (await ops.locator(".qitem").count()) === (await ops.locator(".qitem", { hasText: "Ranked here because" }).count()));
check("the licence item offers Verify and Reject as one click:", (await licenceItem.locator('button[data-act="queue-act"]').allInnerTexts()).join(",") === "Verify,Reject");
await shot(ops, "70-ops-command-centre");
await axeCheck(ops, "ops command centre (O11)");
await ops.locator('button[data-act="queue-filter"]', { hasText: "Partner document to verify" }).click();
check("the filter shows one kind and says it is pressed:", (await ops.locator(".qitem").count()) === (await ops.locator(".qitem", { hasText: "Partner document to verify" }).count()) && (await ops.locator('button[data-act="queue-filter"][aria-pressed="true"]').innerText()).startsWith("Partner document to verify"));
await licenceItem.locator('button[data-act="draft-agree"]').click();
check("one click records that the check is right:", await toastHas(ops, /you agree with the check/));
await eventually("the check now shows as confirmed:", async () => /check confirmed/.test(await licenceItem.innerText()));
{
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mops = await mctx.newPage();
  mops.on("pageerror", (e) => errors.push(`O11 mobile: ${e.message}`));
  await mops.goto(BASE + "/");
  await mops.locator('button[data-email="ops@mkwadvisors.test"]').click();
  await mops.locator('form[data-form="verify"] button[type="submit"]').click();
  await mops.waitForSelector("#nav > :is(a, .navgroup)");
  await mops.goto(BASE + "/#/home"); await mops.reload();
  await mops.waitForSelector(".qitem");
  check("command centre at 390 px has no horizontal overflow:", !(await mops.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mops.screenshot({ path: `${OUT}/71-mobile-command-centre.png`, fullPage: false });
  log.push("71-mobile-command-centre");
  await axeCheck(mops, "ops command centre at 390 px (O11)");
  await mctx.close();
}
// O13 System page: runs and their steps, messages waiting, alerts, the nightly audit check. Every change the web app
// sends carries an idempotency key.
{
  await ops.goto(BASE + "/#/system"); await ops.reload();
  await ops.waitForSelector("#runs-h");
  await ops.locator('button[data-act="run-jobs"]').click();
  check("the jobs run from the System page:", await toastHas(ops, /Jobs run:/));
  await eventually("the run is listed with its steps and the audit chain as checked:", async () => {
    const t = await ops.locator("main").innerText();
    return /\d+ steps/.test(t) && /intact/.test(t);
  });
  check(`every change the web app sent for ops carried an idempotency key (${opsKeyed.length} changes):`, opsKeyed.length > 5 && opsKeyed.every(Boolean));
  await shot(ops, "79-system");
  await axeCheck(ops, "System page (O13)");
  // The same ops session at phone width: another sign-in would count against the per-address sign-in limit.
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await ops.context().storageState() });
  const mops = await mctx.newPage();
  mops.on("pageerror", (e) => errors.push(`O13 mobile: ${e.message}`));
  await mops.goto(BASE + "/#/system");
  await mops.waitForSelector("#runs-h");
  check("System page at 390 px has no horizontal overflow:", !(await mops.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mops.screenshot({ path: `${OUT}/80-mobile-system.png`, fullPage: true });
  log.push("80-mobile-system");
  await axeCheck(mops, "System page at 390 px (O13)");
  await mctx.close();
}
// Ops verifies the licence and moves the firm to pilot
await founder.reload();
await founder.waitForSelector('button[data-act="doc-review"][data-decision="verified"]');
await founder.locator('button[data-act="doc-review"][data-decision="verified"]').click();
await founder.waitForTimeout(800);
check("licence verified:", (await toastHas(founder, /Document verified/)));
await founder.selectOption('form[data-form="partner-move"] select[name="status"]', "under_review");
await founder.fill('form[data-form="partner-move"] input[name="note"]', "Checking references");
await founder.locator('form[data-form="partner-move"] button[type="submit"]').click();
await founder.waitForTimeout(700);
await founder.selectOption('form[data-form="partner-move"] select[name="status"]', "pilot");
await founder.fill('form[data-form="partner-move"] input[name="note"]', "Two pilot jobs first");
await founder.locator('form[data-form="partner-move"] button[type="submit"]').click();
await founder.waitForTimeout(700);
await eventually("partner moved to pilot with a verified licence:", async () => /pilot/i.test(await founder.locator("main .badge").first().innerText()) && /active/.test(await founder.locator("main .kpis").innerText()));
// Client uploads a requested document on the engagement
await client.goto(engagementUrl); await client.reload();
await client.waitForSelector('form[data-form="doc-upload"]');
check("client is asked for documents per step:", (await client.locator('form[data-form="doc-upload"]').count()) >= 1);
// O12: the checklist checks a file before it leaves the page: a wrong type is refused on the spot, nothing is sent.
await client.setInputFiles('form[data-form="doc-upload"] input[name="file"] >> nth=0', { name: "scan.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
await eventually("a wrong file type is refused before upload, beside the item:", async () => /cannot be uploaded/.test(await client.locator("ul.checklist .field-msg").first().innerText()));
check("the refused file is marked invalid for screen readers:", (await client.locator('ul.checklist input[aria-invalid="true"]').count()) === 1);
await shot(client, "74-client-checklist-refused");
await client.setInputFiles('form[data-form="doc-upload"] input[name="file"] >> nth=0', { name: "passport.pdf", mimeType: "application/pdf", buffer: pdfBytes });
await client.locator('form[data-form="doc-upload"] button[type="submit"]').first().click();
await client.waitForTimeout(800);
check("client document uploaded:", (await toastHas(client, /Uploaded/)));
await shot(client, "45-client-documents");
const pdfRes = await client.request.get(BASE + "/api/client/offers/" + standard[1].split("/").pop() + "/pdf");
check("offer PDF downloads for the client:", pdfRes.status() === 200 && (await pdfRes.text()).startsWith("%PDF") && !/Example Setup/.test(await pdfRes.text()));
// Partner marks the document received
const docPartner = partnerPages[0];
await docPartner.goto(engagementUrl); await docPartner.reload();
await docPartner.waitForSelector("main h1");
if (await docPartner.locator('button[data-act="doc-decide"][data-decision="received"]').count()) {
  await docPartner.locator('button[data-act="doc-decide"][data-decision="received"]').first().click();
  await docPartner.waitForTimeout(700);
  check("partner marked the client document received:", (await toastHas(docPartner, /Marked received/)));
}
// Delays page for ops
await ops.goto(BASE + "/#/delays"); await ops.reload();
await ops.waitForSelector('main h1:text-is("Delays and service guarantee")');
await shot(ops, "46-ops-delays");

// Reporting and compliance (O8): dashboard, accounting export, compliance calendar, partner performance
await founder.goto(BASE + "/#/dashboard"); await founder.reload();
await founder.waitForSelector('main h1:text-is("Dashboard")');
const dashText = await founder.locator("main").innerText();
check("founder dashboard shows revenue, cash and margin:", /Revenue/.test(dashText) && /Cash collected/.test(dashText) && /Margin on accepted offers/.test(dashText));
await shot(founder, "49-founder-dashboard");
await ops.goto(BASE + "/#/dashboard"); await ops.reload();
await ops.waitForSelector('main h1:text-is("Dashboard")');
check("ops dashboard hides margin:", !/Margin on accepted offers/.test(await ops.locator("main").innerText()));
const today = new Date().toISOString().slice(0, 10);
const csv = await founder.request.get(`${BASE}/api/admin/accounting/export?set=sales&from=2026-01-01&to=${today}`);
check("accounting export downloads as CSV:", csv.status() === 200 && /text\/csv/.test(csv.headers()["content-type"] ?? "") && (await csv.text()).startsWith("Date,Type,Number"));
const marginCsv = await ops.request.get(`${BASE}/api/admin/accounting/export?set=margin&from=2026-01-01&to=${today}`);
check("ops cannot export margin:", marginCsv.status() === 403);
// Ops adds an obligation for the sample client; the client uploads the filing confirmation; ops marks it met
await ops.goto(BASE + "/#/compliance"); await ops.reload();
await ops.waitForSelector('form[data-form="obligation-add"]');
await ops.selectOption('form[data-form="obligation-add"] select[name="kind"]', "vat_return");
await ops.fill('form[data-form="obligation-add"] input[name="title"]', "VAT return Q4 2026");
await ops.fill('form[data-form="obligation-add"] input[name="dueDate"]', "2027-01-28");
await ops.selectOption('form[data-form="obligation-add"] select[name="recurrence"]', "quarterly");
await ops.fill('form[data-form="obligation-add"] input[name="basis"]', "FTA portal, tax period Oct-Dec");
await ops.locator('form[data-form="obligation-add"] button[type="submit"]').click();
await ops.waitForTimeout(800);
await eventually("obligation added:", async () => /VAT return Q4 2026/.test(await ops.locator("main").innerText()));
await shot(ops, "50-ops-compliance");
await client.goto(BASE + "/#/compliance"); await client.reload();
await client.waitForSelector('main h1:text-is("Your compliance calendar")');
check("client sees the confirmed obligation:", /VAT return Q4 2026/.test(await client.locator("main").innerText()));
await client.setInputFiles('form[data-form="obligation-evidence"] input[name="file"] >> nth=0', { name: "vat-return-acknowledgement.pdf", mimeType: "application/pdf", buffer: pdfBytes });
await client.locator('form[data-form="obligation-evidence"] button[type="submit"]').first().click();
await client.waitForTimeout(800);
check("client uploaded filing evidence:", (await toastHas(client, /MKW Advisors will check/)));
await shot(client, "51-client-compliance");
// E5: a saved public result becomes the signed-in client's request without re-typing; a renewal is asked for from
// the obligation that is due.
{
  const saved = await (await pub.request.post(BASE + "/api/public/assessments", { data: { answers: { emirate: "Dubai", activity: "consulting", customers: "international", visas: 1, budgetAed: 20000 }, attribution: { source: "smoke", campaign: "handoff" } } })).json();
  await client.goto(BASE + "/#/new"); await client.reload();
  await client.waitForSelector('form[data-form="from-assessment"]');
  await client.fill("#saved-code", saved.code);
  await client.locator('form[data-form="from-assessment"] button[type="submit"]').click();
  await eventually("a saved result became the client's request without re-typing (E5):", async () => /^#\/request\//.test(await client.evaluate(() => location.hash)));
  const fromAssessment = (await client.evaluate(() => location.hash)).replace("#/request/", "");
  await ops.goto(BASE + "/#/request/" + fromAssessment); await ops.reload();
  await ops.waitForSelector('form[data-form="approve-advice"]');
  check("the review shows the saved result then against today's advice (E5):", /From a saved public result/.test(await ops.locator("main").innerText()) && /smoke \/ handoff/.test(await ops.locator("main").innerText()));
  await shot(ops, "90-review-from-saved-result");
  const clients = await (await ops.request.get(BASE + "/api/ops/clients")).json();
  const sampleClient = clients.find((c) => /Sample Trading/.test(c.name)) ?? clients[0];
  const ob = await (await ops.request.post(BASE + `/api/ops/clients/${sampleClient.id}/obligations`, { data: { kind: "licence_renewal", title: "Trade licence renewal", dueDate: "2027-03-01", recurrence: "yearly", basis: "On the licence" } })).json();
  await client.goto(BASE + "/#/compliance"); await client.reload();
  await client.waitForSelector(`button[data-act="renewal-request"][data-id="${ob.id}"]`);
  await client.locator(`button[data-act="renewal-request"][data-id="${ob.id}"]`).click();
  await eventually("the client asked for a renewal offer from the obligation (E5):", async () => /Renewal requested/.test(await client.locator("main").innerText()));
  await client.goto(BASE + "/#/compliance"); await client.reload();
  await client.waitForSelector('main h1:text-is("Your compliance calendar")');
  check("the obligation shows its renewal request after a reload too (E5):", /Renewal requested/.test(await client.locator("main").innerText()));
  await shot(client, "91-client-renewal-requested");
  await axeCheck(client, "client compliance with a renewal request (E5)");
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, storageState: await client.context().storageState() });
  const m = await mctx.newPage();
  m.on("pageerror", (e) => errors.push(`E5 mobile: ${e.message}`));
  await m.goto(BASE + "/#/new"); await m.waitForSelector('form[data-form="from-assessment"]');
  check("the saved-result box at 390 px has no horizontal overflow (E5):", !(await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await m.screenshot({ path: `${OUT}/92-mobile-saved-result.png`, fullPage: false });
  log.push("92-mobile-saved-result");
  await mctx.close();
  await ops.goto(BASE + "/#/compliance"); await ops.reload();
  await ops.waitForSelector("main h1");
}
await ops.reload();
await ops.waitForSelector('button[data-act="obligation-met"]');
await ops.locator('button[data-act="obligation-met"]').first().click();
await ops.waitForTimeout(800);
check("ops marked the obligation met:", await toastHas(ops, /Marked met/));
await eventually("the next obligation rolled forward:", async () => (await ops.locator("main").innerText()).split("VAT return Q4 2026").length >= 3);
// Partner performance
await partnerPages[0].goto(BASE + "/#/performance"); await partnerPages[0].reload();
await partnerPages[0].waitForSelector('main h1:text-is("Your performance")');
check("partner performance page has no client or margin figures:", !/margin|client price/i.test(await partnerPages[0].locator("main").innerText()));
await shot(partnerPages[0], "52-partner-performance");

// Arabic and accessibility (O9): sign-off gate, Arabic client screens, axe-core on key screens, keyboard-only path
const a11y = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
const ap = await a11y.newPage();
ap.on("pageerror", (e) => errors.push(`a11y: ${e.message}`));
await ap.goto(BASE + "/");
await ap.waitForSelector("form");
await axeCheck(ap, "sign-in (en)");
// Keyboard only: reach the email field, request a code, sign in, open the offer
await ap.keyboard.press("Tab"); // skip link
check("skip link is the first focus stop:", await ap.evaluate(() => document.activeElement?.classList.contains("skip")));
await ap.keyboard.press("Enter");
await ap.waitForTimeout(200);
check("activating the skip link moves focus to the page without changing the route:", await ap.evaluate(() => document.activeElement?.id === "app" && location.hash !== "#app") && (await ap.locator("form").count()) >= 1);
check("the document title follows the heading:", /Sign in/.test(await ap.title()));
let focusedEmail = false;
for (let i = 0; i < 6 && !focusedEmail; i++) { await ap.keyboard.press("Tab"); focusedEmail = await ap.evaluate(() => document.activeElement?.id === "email"); }
check("keyboard reaches the email field:", focusedEmail);
await ap.keyboard.type("founder@sample-client.test");
await ap.keyboard.press("Enter");
await ap.waitForSelector('form[data-form="verify"]');
await ap.keyboard.press("Enter"); // the code is focused and filled in development mode
await ap.waitForSelector("#nav > :is(a, .navgroup)");
let onOffer = false;
for (let i = 0; i < 60 && !onOffer; i++) {
  await ap.keyboard.press("Tab");
  if (await ap.evaluate(() => (document.activeElement?.getAttribute("href") ?? "").includes("#/engagement/"))) { await ap.keyboard.press("Enter"); onOffer = true; }
}
await ap.waitForSelector('main h1:has-text("Engagement")');
check("keyboard-only path opens the engagement:", onOffer);
await ap.goto(BASE + "/" + standard[1]); await ap.waitForSelector('main h1:text-is("Your offer")');
await axeCheck(ap, "client offer (en)");
await ap.goto(BASE + "/#/"); await ap.waitForSelector("main h1");
await axeCheck(ap, "client home (en)");
await ap.goto(engagementUrl); await ap.waitForSelector("main h1");
await axeCheck(ap, "client engagement (en)");
await ap.goto(BASE + "/#/compliance"); await ap.waitForSelector("main h1");
await axeCheck(ap, "client compliance (en)");
await ap.goto(BASE + "/#/new"); await ap.waitForSelector('form[data-form="intake"]');
await axeCheck(ap, "client intake (en)");
// Partner and public pages
const ap2 = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true })).newPage();
ap2.on("pageerror", (e) => errors.push(`a11y partner: ${e.message}`));
await ap2.goto(BASE + "/");
await ap2.locator('button[data-email="admin@setup-partner.test"]').click();
await ap2.locator('form[data-form="verify"] button[type="submit"]').click();
await ap2.waitForSelector("#nav > :is(a, .navgroup)");
await axeCheck(ap2, "partner home (en)");
await ap2.goto(BASE + "/#/firm"); await ap2.waitForSelector("main h1");
await axeCheck(ap2, "partner firm (en)");
await ap2.goto(BASE + "/intake.html"); await ap2.waitForSelector("#intake");
await axeCheck(ap2, "public intake (en)");
// Before the sign-off a client cannot switch to Arabic; the founder records it on Settings
await client.goto(BASE + "/#/"); await client.reload();
await client.waitForSelector("main h1");
check("no Arabic switch for clients before the sign-off:", (await client.locator('button[data-act="lang"]').count()) === 0);
await founder.goto(BASE + "/#/settings"); await founder.reload();
await founder.waitForSelector('form[data-form="arabic-review"]');
await founder.fill('form[data-form="arabic-review"] input[name="reviewedBy"]', "Huda Al Marri, legal translator");
await founder.fill('form[data-form="arabic-review"] input[name="note"]', "Dictionary v1 and client templates");
await founder.locator('form[data-form="arabic-review"] button[value="1"]').click();
await founder.waitForTimeout(800);
check("Arabic sign-off recorded:", (await toastHas(founder, /sign-off recorded/)));
// The client switches to Arabic: right-to-left, Arabic headings, numbers left-to-right
await client.reload();
await client.waitForSelector('button[data-act="lang"]');
await client.locator('button[data-act="lang"]').click();
await client.waitForSelector('html[dir="rtl"]');
await client.waitForTimeout(600);
await eventually("client home renders in Arabic, right-to-left:", async () => (await client.getAttribute("html", "lang")) === "ar" && /شركتك مع تأسيس/.test(await client.locator("main").innerText()));
await shot(client, "55-client-home-ar");
await client.goto(BASE + "/" + standard[1]); await client.waitForSelector("main h1");
await eventually("offer in Arabic keeps amounts and the accept wording:", async () => {
  const offerAr = await client.locator("main").innerText();
  return /عرضك/.test(offerAr) && /AED [\d,]+/.test(offerAr);
});
await shot(client, "56-client-offer-ar");
await client.goto(engagementUrl); await client.waitForSelector("main h1");
await client.waitForTimeout(500);
await eventually("engagement in Arabic:", async () => /الخطوات/.test(await client.locator("main").innerText()));
await shot(client, "57-client-engagement-ar");
await client.goto(BASE + "/#/compliance"); await client.waitForSelector("main h1");
// Wait for the compliance page itself, not the previous page's heading that is still on screen while it loads.
await eventually("compliance in Arabic:", async () => /تقويم التزاماتك/.test(await client.locator("main").innerText()));
await shot(client, "58-client-compliance-ar");
await pp.goto(BASE + "/intake.html?lang=ar"); await pp.waitForSelector('html[dir="rtl"]');
await pp.waitForTimeout(400);
await eventually("public intake in Arabic:", async () => /شركتك في الإمارات/.test(await pp.locator("main").innerText()));
// E3: the selector's questions and controls are translated too, question by question.
await pp.goto(BASE + "/selector.html?lang=ar"); await pp.waitForSelector('html[dir="rtl"]');
check("the homepage in Arabic (E7A):", /اعثر على الكيان الإماراتي المناسب/.test(await pp.locator("main").innerText()));
await pp.locator("#start").click();
await pp.waitForSelector("#questions .choice");
check("the public selector in Arabic, first question:", /ما النشاط الرئيسي للشركة/.test(await pp.locator("main").innerText()) && /التالي/.test(await pp.locator("#next").innerText()));
await pp.locator('.choice[data-val="tech"]').click(); await pp.locator("#next").click();
await pp.waitForTimeout(300);
check("the public selector in Arabic, second question:", /أين عملاؤك/.test(await pp.locator("#step").innerText()));
await shot(pp, "59-public-intake-ar");
// axe on the Arabic screens (same account, new context that bypasses CSP for the axe script only)
const ap3 = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true })).newPage();
ap3.on("pageerror", (e) => errors.push(`a11y ar: ${e.message}`));
await ap3.goto(BASE + "/");
await ap3.locator('button[data-email="founder@sample-client.test"]').click();
await ap3.locator('form[data-form="verify"] button[type="submit"]').click();
await ap3.waitForSelector("#nav > :is(a, .navgroup)");
await ap3.waitForSelector('html[dir="rtl"]');
await axeCheck(ap3, "client home (ar)");
await ap3.goto(BASE + "/" + standard[1]); await ap3.waitForSelector("main h1");
await axeCheck(ap3, "client offer (ar)");
await ap3.goto(engagementUrl); await ap3.waitForSelector("main h1");
await axeCheck(ap3, "client engagement (ar)");
await ap3.goto(BASE + "/#/compliance"); await ap3.waitForSelector("main h1");
await axeCheck(ap3, "client compliance (ar)");
await ap3.goto(BASE + "/#/new"); await ap3.waitForSelector('form[data-form="intake"]');
await axeCheck(ap3, "client intake (ar)");
check("the Arabic document title follows the heading:", /تأسيس/.test(await ap3.title()));
// A message a partner wrote is never rewritten by the dictionary, even when it equals a dictionary key.
await ap3.goto(engagementUrl); await ap3.reload(); await ap3.waitForSelector(".msg");
const msgs = await ap3.locator(".msg div[data-no-i18n]").allInnerTexts();
check("people's own words are left untranslated:", msgs.length >= 1 && msgs.every((m) => !/[\u0600-\u06FF]/.test(m)));
// U1: the gap list the Arabic reviewer sees (strings seen on client screens without an entry) holds none of the
// strings U1 added. The list also carries service names, amounts, file names and older strings, which are logged.
{
  await ap3.waitForTimeout(800);
  const gaps = await founder.evaluate(async () => (await (await fetch("/api/admin/arabic")).json()).gaps ?? []);
  const u1 = ["Money", "Invoiced, net of credit notes", "Statement and invoices", "Compliance calendar", "Full calendar", "One offer, with another option", "One offer, with other options", "Choose an option", "Priority", "Standard", "Essential", "selected", "In short", "nothing due", "All steps"];
  const u1Shapes = [/^(Priority|Standard|Essential) · AED/, /^Switch to /, /fits what you told us/, /needs? confirming before we quote/, /^Accept this offer/, / due now$/, /^about \d+ working days$/, /^No option fits/, /^The reasoning:/, /^The setup estimate for/, /^\d+ of \d+ approved$/];
  const leaked = gaps.filter((g) => u1.includes(g) || u1Shapes.some((re) => re.test(g)));
  log.push(`arabic gaps reported by the client screens (${gaps.length}): ${gaps.join(" | ")}`);
  check("no string U1 added appears untranslated on the client screens visited in Arabic (U1):", leaked.length === 0 && gaps.length > 0);
}
await ap3.goto(BASE + "/intake.html?lang=ar"); await ap3.waitForSelector('html[dir="rtl"]');
await axeCheck(ap3, "public intake (ar)");
// O10: legal texts and holidays on Settings, the grouped console menu, the partner agreement, an imported prospect.
{
  const signIn = async (page, email) => {
    await page.goto(BASE + "/");
    await page.locator(`button[data-email="${email}"]`).click();
    await page.locator('form[data-form="verify"] button[type="submit"]').click();
    await page.waitForSelector("#nav > :is(a, .navgroup)");
  };
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const fp = await desk.newPage();
  fp.on("pageerror", (e) => errors.push(`O10 founder: ${e.message}`));
  fp.on("dialog", (d) => d.accept(d.type() === "prompt" ? "Announced by the government" : undefined));
  await signIn(fp, "founder@mkwadvisors.test");
  // The staff menu: four entries on one row; a menu opens and closes by keyboard.
  const oneRow = await fp.evaluate(() => {
    const items = [...document.querySelectorAll("#nav > a, #nav > .navgroup")].map((e) => e.getBoundingClientRect().top);
    return items.length > 0 && Math.max(...items) - Math.min(...items) < 4;
  });
  check("staff menu fits on one row at 1280 px:", oneRow);
  check("staff menu has four entries (Work, Partners, Dashboard, Setup):", (await fp.locator("#nav > a, #nav > .navgroup").count()) === 4);
  await fp.locator('#nav button[aria-controls="nav-work"]').focus();
  await fp.keyboard.press("Enter");
  const openWork = await fp.evaluate(() => !document.getElementById("nav-work").hidden && document.activeElement?.getAttribute("href") === "#/home");
  check("Enter opens the Work menu and focuses its first link:", openWork);
  await fp.screenshot({ path: `${OUT}/61-console-menu.png`, fullPage: false });
  log.push("61-console-menu");
  await axeCheck(fp, "console with the Work menu open (O10)");
  await fp.keyboard.press("Escape");
  check("Escape closes the menu and returns focus to its button:", await fp.evaluate(() => document.getElementById("nav-work").hidden && document.activeElement?.getAttribute("aria-controls") === "nav-work"));
  await fp.locator('#nav button[aria-controls="nav-setup"]').click();
  await fp.locator('#nav-setup a[href="#/settings"]').click();
  await fp.waitForSelector('form[data-form="holiday-set"]');
  check("Setup tells screen readers which page is open:", /Setup: Settings/.test((await fp.locator('#nav button[aria-controls="nav-setup"]').textContent()) ?? "") && (await fp.locator('#nav button[aria-controls="nav-setup"].on').count()) === 1);
  check("staff menu still on one row with the longest label open:", await fp.evaluate(() => {
    const items = [...document.querySelectorAll("#nav > a, #nav > .navgroup")].map((e) => e.getBoundingClientRect().top);
    return Math.max(...items) - Math.min(...items) < 4;
  }));
  // Legal texts: both drafts; the founder records the lawyer's review of the client terms.
  check("settings lists both legal texts as drafts:", (await fp.locator('form[data-form="legal-signoff"]').count()) === 2);
  const signoff = fp.locator('form[data-form="legal-signoff"][data-kind="client_terms"]');
  await signoff.locator('input[name="lawyer"]').fill("Demo Law LLP");
  await signoff.locator('input[name="approvedOn"]').fill("2026-10-18");
  await signoff.locator('button[type="submit"]').click();
  await fp.waitForSelector('form[data-form="legal-signoff"][data-kind="client_terms"]', { state: "detached" });
  check("the review is recorded and the client terms are no longer a draft:", /Demo Law LLP/.test(await fp.locator("main").innerText()));
  // Holidays: the founder adds an expected date with its source.
  const hf = fp.locator('form[data-form="holiday-set"]');
  await hf.locator('input[name="date"]').fill("2027-03-09");
  await hf.locator('input[name="name"]').fill("Eid Al Fitr");
  await hf.locator('input[name="reason"]').fill("Expected date, published 2027 calendar");
  await hf.locator('button[type="submit"]').click();
  await fp.waitForSelector('button[data-act="holiday-confirm"][data-date="2027-03-09"]');
  check("the holiday shows as expected until confirmed:", /Eid Al Fitr/.test(await fp.locator("main").innerText()));
  await shot(fp, "62-settings-legal-holidays");
  await axeCheck(fp, "settings: legal texts and holidays (O10)");
  // An imported prospect, as ops sees it (synthetic firm from the development seed).
  const op = await desk.newPage();
  op.on("pageerror", (e) => errors.push(`O10 ops: ${e.message}`));
  await op.goto(BASE + "/#/partners");
  await op.reload();
  await op.locator("main a", { hasText: "Example Prospect Consultants" }).first().click();
  await op.waitForSelector("text=From the partner roster");
  const roster = await op.locator("main").innerText();
  check("an imported prospect shows its Partner ID and an unconfirmed FTA claim:", /GB0000/.test(roster) && /check the FTA register/.test(roster) && /prospect/.test(roster));
  await shot(op, "63-ops-imported-prospect");
  await desk.close();

  // The partner admin reads and accepts the Partner Network Agreement; only MKW Advisors is named.
  const pctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, bypassCSP: true });
  const pp = await pctx.newPage();
  pp.on("pageerror", (e) => errors.push(`O10 partner: ${e.message}`));
  pp.on("dialog", (d) => d.accept());
  await signIn(pp, "admin@setup-partner.test");
  await pp.goto(BASE + "/#/firm");
  await pp.reload();
  await pp.waitForSelector('button[data-act="agreement-accept"]');
  check("the partner sees the agreement as a draft pending legal review:", (await pp.getByText("Draft, pending legal review").count()) >= 1);
  await axeCheck(pp, "partner firm: the agreement (O10)");
  await pp.locator('button[data-act="agreement-accept"]').click();
  await pp.waitForSelector("text=Accepted online: version 1");
  check("partner screens never show the name Tasees:", !/\bTasees\b/.test(await pp.locator("body").innerText()));
  await shot(pp, "64-partner-agreement");
  await pctx.close();

  // Phone width: the menu opens as a panel and nothing runs off the screen.
  const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mp2 = await mob.newPage();
  mp2.on("pageerror", (e) => errors.push(`O10 mobile: ${e.message}`));
  await signIn(mp2, "founder@mkwadvisors.test");
  await mp2.goto(BASE + "/#/settings");
  await mp2.reload();
  await mp2.waitForSelector('form[data-form="holiday-set"]');
  await mp2.locator('#nav button[aria-controls="nav-setup"]').click();
  const overOpen = await mp2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check("console menu open at 390 px has no horizontal overflow:", !overOpen);
  await mp2.screenshot({ path: `${OUT}/65-mobile-console-menu.png`, fullPage: false });
  log.push("65-mobile-console-menu");
  await axeCheck(mp2, "console with the Setup menu open at 390 px (O10)");
  await mp2.keyboard.press("Escape");
  await mp2.locator("h2", { hasText: "Legal texts" }).scrollIntoViewIfNeeded();
  check("settings with legal texts and holidays at 390 px has no horizontal overflow:", !(await mp2.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mp2.screenshot({ path: `${OUT}/66-mobile-settings-legal.png`, fullPage: false });
  log.push("66-mobile-settings-legal");
  await axeCheck(mp2, "settings: legal texts and holidays at 390 px (O10)");
  const mobPartner = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const mpart = await mobPartner.newPage();
  mpart.on("pageerror", (e) => errors.push(`O10 mobile partner: ${e.message}`));
  await signIn(mpart, "admin@setup-partner.test");
  await mpart.goto(BASE + "/#/firm");
  await mpart.reload();
  await mpart.waitForSelector("text=Partner Network Agreement");
  check("partner agreement at 390 px has no horizontal overflow:", !(await mpart.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  await mpart.locator("h2", { hasText: "Partner Network Agreement" }).scrollIntoViewIfNeeded();
  await mpart.screenshot({ path: `${OUT}/67-mobile-partner-agreement.png`, fullPage: false });
  log.push("67-mobile-partner-agreement");
  await axeCheck(mpart, "partner firm: the agreement at 390 px (O10)");
  await mobPartner.close();
  await mob.close();
}

writeFileSync(`${OUT}/axe.json`, JSON.stringify(axeResults, null, 2));
// Back to English for the mobile shots that follow, after one Arabic phone shot
const mar = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
await mar.goto(BASE + "/");
await mar.locator('button[data-email="founder@sample-client.test"]').click();
await mar.locator('form[data-form="verify"] button[type="submit"]').click();
await mar.waitForSelector("#nav > :is(a, .navgroup)");
await mar.waitForSelector('html[dir="rtl"]');
await mar.waitForTimeout(600);
check("Arabic home at 390 px has no horizontal overflow:", !(await mar.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await mar.screenshot({ path: `${OUT}/60-mobile-home-ar.png`, fullPage: false });
await client.locator('button[data-act="lang"]').click();
await client.waitForSelector('html[dir="ltr"]');

// Mobile views of the new screens
const mf = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mfp = await mf.newPage();
mfp.on("pageerror", (e) => errors.push(`mobile founder: ${e.message}`));
await mfp.goto(BASE + "/");
await mfp.locator('button[data-email="founder@mkwadvisors.test"]').click();
await mfp.locator('form[data-form="verify"] button[type="submit"]').click();
await mfp.waitForSelector("#nav > :is(a, .navgroup)");
for (const [route, name] of [["people", "20-mobile-people"], ["settings", "21-mobile-settings"], ["catalogue", "27-mobile-catalogue"], ["rules", "28-mobile-rules"], ["partners", "33-mobile-partners-runs"], ["scoping", "40-mobile-scoping"], ["agent", "41-mobile-ai-queue"], ["delays", "47-mobile-delays"], ["dashboard", "53-mobile-dashboard"], ["compliance", "54-mobile-compliance"]]) {
  await mfp.goto(BASE + "/#/" + route); await mfp.reload();
  await mfp.waitForSelector("main h1");
  await mfp.waitForTimeout(600);
  const over = await mfp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${route} at 390 px has no horizontal overflow:`, !over);
  await mfp.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

// The new partner's firm page at phone width
const mpp = await (await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
mpp.on("pageerror", (e) => errors.push(`mobile partner: ${e.message}`));
await mpp.goto(BASE + "/");
await mpp.fill('form[data-form="request-code"] input[name="email"]', partnerEmail);
await mpp.locator('form[data-form="request-code"] button[type="submit"]').click();
await mpp.waitForSelector('form[data-form="verify"]');
await mpp.locator('form[data-form="verify"] button[type="submit"]').click();
await mpp.waitForSelector("#nav > :is(a, .navgroup)");
await mpp.goto(BASE + "/#/firm"); await mpp.reload();
await mpp.waitForSelector("main h1");
await mpp.waitForTimeout(600);
check("firm page at 390 px has no horizontal overflow:", !(await mpp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
await mpp.screenshot({ path: `${OUT}/48-mobile-firm.png`, fullPage: false });

writeFileSync(`${OUT}/log.txt`, [...log, "ERRORS:", ...errors].join("\n"));
console.log([...log, "ERRORS:", ...errors].join("\n"));
await browser.close();
if (errors.length) {
  console.error(`SMOKE TEST FAILED: ${errors.length} error(s)`);
  process.exitCode = 1;
} else {
  console.log("SMOKE TEST PASSED");
}
