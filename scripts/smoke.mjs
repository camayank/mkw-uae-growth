// Browser smoke test: drives one engagement end to end through the web app as client, ops, finance and partners,
// and saves a screenshot of each key screen. Run against a freshly seeded demo server started with DEV_LOGIN=1:
//   pnpm seed && pnpm --filter @tasees/api demo   (in another terminal)
//   npm i -D playwright@1.49.1 && npx playwright install chromium && node scripts/smoke.mjs
// It prints a log and checks that the client never sees partner cost, margin or masked contact details.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

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

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`${email} console: ${m.text()}`));
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? (d.message().includes("Type ERASE") ? "ERASE" : d.defaultValue() || "REF-12345") : undefined));
  await page.goto(BASE + "/");
  await page.locator(`button[data-email="${email}"]`).click();
  await page.locator('form[data-form="verify"] button[type="submit"]').click();
  await page.waitForSelector("#nav a");
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
  await page.waitForSelector("#nav a");
  return page;
}
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  log.push(name);
};
const toastText = async (page) => (await page.locator("#toast").textContent()) ?? "";

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
await client.selectOption('select[name="jurisdiction"]', "free_zone");
await client.fill('input[name="visas"]', "2");
await client.check('input[name="extra"][value="BANK-ACC"]');
await client.check('input[name="extra"][value="VAT-RET"]');
await client.selectOption('select[name="activity"]', "tech");
await client.selectOption('select[name="customers"]', "international");
await client.fill('input[name="expectedTurnoverAed"]', "500000");
await client.fill('textarea[name="description"]', "Three partners starting a software company, 2 visas, bank account and VAT registration");
await shot(client, "02-client-intake");
await client.locator('form[data-form="intake"] button[type="submit"]').click();
await client.waitForTimeout(800);
log.push("request: " + (await toastText(client)));

// Ops: price and publish
const ops = await session("ops@mkwadvisors.test");
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

// Client: view and accept
await client.goto(BASE + "/" + standard[1]);
await client.waitForSelector('button[data-act="accept-offer"]');
await shot(client, "07-client-offer");
await client.locator('button[data-act="accept-offer"]').click();
await client.waitForURL(/engagement/);
const engagementUrl = client.url();
await client.waitForTimeout(600);
await shot(client, "08-client-engagement-awaiting-payment");
check("client sees a card payment link for the deposit:", (await client.locator('a:text-is("Pay by card")').count()) >= 1);

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
  if (n && !log.some((l) => l.startsWith("shot-partner"))) { await shot(p, "10-partner-offered-work"); log.push("shot-partner"); }
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
  const first = p.locator("ul.milestones li").first();
  const types = await first.locator('select[name="type"] option').evaluateAll((os) => os.map((o) => o.value).filter((v) => v !== "other"));
  for (const t of types) {
    await p.locator("ul.milestones li").first().locator('select[name="type"]').selectOption(t);
    await p.locator("ul.milestones li").first().locator('input[type="file"]').setInputFiles({ name: `${t}.pdf`, mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 demo") });
    await p.locator("ul.milestones li").first().locator('form[data-form="evidence"] button').click();
    await p.waitForTimeout(700);
  }
  await p.locator("ul.milestones li").first().locator('button[data-act="ms-submit"]').click();
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
await client.locator('button[data-act="ms-review"][data-approve="1"]').first().click();
await client.waitForTimeout(700);
log.push("approve: " + (await toastText(client)));
const pageText = await client.locator("main").innerText();
check("client page hides the partner's phone and email:", !pageText.includes("123 4567") && !pageText.includes("ali@example.com"));
check("client page shows no partner cost or margin:", !/partner cost|margin/i.test(pageText));
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
await client.waitForTimeout(600);
check("mark all as read clears the bell:", (await client.locator("#who .bell .count").count()) === 0);
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
await mp.waitForSelector("#nav a");
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
check("deactivated user shows the badge and a reactivate button:", (await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator(".badge.bad").count()) === 1 && (await founder.locator("tr", { hasText: `staff-${stamp}@new-partner.test` }).locator('button[data-act="user-reactivate"]').count()) === 1);
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
check("erased person shown as a tombstone:", (await founder.locator("tr", { hasText: "Erased person" }).count()) > 0);
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
await founder.fill('form[data-form="retention"] input[name="note"]', "Smoke test: confirmed by the founder");
await founder.locator('form[data-form="retention"] button[type="submit"]').click();
await founder.waitForTimeout(800);
log.push("retention: " + (await toastText(founder)));
check("no UNCERTAIN retention badge after the founder confirms:", (await founder.locator('form[data-form="retention"] .badge:text-is("UNCERTAIN")').count()) === 0);
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
await founder.waitForTimeout(800);
log.push("company: " + (await toastText(founder)));
await founder.locator('button[data-act="issue-held"]').click();
await founder.waitForTimeout(800);
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
check("payout run marked paid:", /paid/.test((await finance.locator("main tbody").last().innerText())));
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
await shot(ops, "35-ops-scoping-review");
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
await shot(client, "36-client-advice");
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
check("verified rule shows the verifier:", /A\. Qualified, FTA tax agent/.test(await founder.locator("main").innerText()));
await shot(founder, "38-scoping-rules");
// Public intake page, no sign-in
const pub = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const pp = await pub.newPage();
pp.on("pageerror", (e) => errors.push(`intake page: ${e.message}`));
await pp.goto(BASE + "/intake.html?utm_campaign=smoke");
await pp.fill("#company", "Smoke Lead Ventures");
await pp.fill("#name", "Smoke Lead");
await pp.fill("#email", `lead-${stamp}@smoke.test`);
await pp.selectOption("#activity", "consulting");
await pp.selectOption("#customers", "international");
await pp.check('input[name="consent"]');
await shot(pp, "39-public-intake");
await pp.locator('button[type="submit"]').click();
await pp.waitForTimeout(1200);
check("public intake accepted the lead:", /Thank you. We have your request/.test(await pp.locator("#msg").innerText()));
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
check("repeat lead gets the same answer:", /Thank you. We have your request/.test(await pp.locator("#msg").innerText()));
await ops.goto(BASE + "/#/agent"); await ops.reload();
await ops.waitForSelector('main h1:text-is("AI review queue")');
check("repeat lead is held for ops, not attached:", /Held leads/.test(await ops.locator("main").innerText()) && /Second Try Co/.test(await ops.locator("main").innerText()));
await shot(ops, "42-held-leads");
await ops.fill('form[data-form="lead"] input[name="note"]', "Duplicate of the first lead");
await ops.locator('form[data-form="lead"] button[type="submit"]').click();
await ops.waitForTimeout(600);
check("held lead marked handled:", !/Second Try Co/.test(await ops.locator("main").innerText()));

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
check("new fee shows as UNCERTAIN:", (await founder.locator('.badge:text-is("UNCERTAIN")').count()) >= 1 && (await founder.locator("main").innerText()).includes("IFZA"));
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
check("scheduled rule change is listed with its date:", /22\.0%.*AED 350.*from 1 Jan 2030/s.test(await founder.locator("main").innerText()));
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
check("partner moved to contacted:", /contacted/i.test(await founder.locator("main .badge").first().innerText()));
// The new partner's admin completes the application and uploads the trade licence
await newPartnerAdmin.goto(BASE + "/#/firm"); await newPartnerAdmin.reload();
await newPartnerAdmin.waitForSelector('form[data-form="application"]');
await newPartnerAdmin.fill('form[data-form="application"] input[name="licenceNumber"]', "DED-SMOKE-1");
await newPartnerAdmin.fill('form[data-form="application"] input[name="licenceExpiry"]', "2027-12-31");
await newPartnerAdmin.check('form[data-form="application"] input[name="emirates"][value="Dubai"]');
await newPartnerAdmin.locator('form[data-form="application"] button[type="submit"]').click();
await newPartnerAdmin.waitForTimeout(800);
check("application submitted:", /Application saved/.test(await toastText(newPartnerAdmin)) && /applied/i.test(await newPartnerAdmin.locator("main .badge").first().innerText()));
await newPartnerAdmin.selectOption('form[data-form="partner-doc"] select[name="kind"]', "trade_licence");
await newPartnerAdmin.fill('form[data-form="partner-doc"] input[name="expiresOn"]', "2027-12-31");
await newPartnerAdmin.setInputFiles('form[data-form="partner-doc"] input[name="file"]', { name: "trade-licence.pdf", mimeType: "application/pdf", buffer: pdfBytes });
await newPartnerAdmin.locator('form[data-form="partner-doc"] button[type="submit"]').click();
await newPartnerAdmin.waitForTimeout(800);
check("trade licence uploaded, awaiting MKW check:", /awaiting MKW check/.test(await newPartnerAdmin.locator("main").innerText()));
await shot(newPartnerAdmin, "44-partner-firm");
// Ops verifies the licence and moves the firm to pilot
await founder.reload();
await founder.waitForSelector('button[data-act="doc-review"][data-decision="verified"]');
await founder.locator('button[data-act="doc-review"][data-decision="verified"]').click();
await founder.waitForTimeout(800);
check("licence verified:", /Document verified/.test(await toastText(founder)));
await founder.selectOption('form[data-form="partner-move"] select[name="status"]', "under_review");
await founder.fill('form[data-form="partner-move"] input[name="note"]', "Checking references");
await founder.locator('form[data-form="partner-move"] button[type="submit"]').click();
await founder.waitForTimeout(700);
await founder.selectOption('form[data-form="partner-move"] select[name="status"]', "pilot");
await founder.fill('form[data-form="partner-move"] input[name="note"]', "Two pilot jobs first");
await founder.locator('form[data-form="partner-move"] button[type="submit"]').click();
await founder.waitForTimeout(700);
check("partner moved to pilot with a verified licence:", /pilot/i.test(await founder.locator("main .badge").first().innerText()) && /active/.test(await founder.locator("main .kpis").innerText()));
// Client uploads a requested document on the engagement
await client.goto(engagementUrl); await client.reload();
await client.waitForSelector('form[data-form="doc-upload"]');
check("client is asked for documents per step:", (await client.locator('form[data-form="doc-upload"]').count()) >= 1);
await client.setInputFiles('form[data-form="doc-upload"] input[name="file"] >> nth=0', { name: "passport.pdf", mimeType: "application/pdf", buffer: pdfBytes });
await client.locator('form[data-form="doc-upload"] button[type="submit"]').first().click();
await client.waitForTimeout(800);
check("client document uploaded:", /Uploaded/.test(await toastText(client)));
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
  check("partner marked the client document received:", /Marked received/.test(await toastText(docPartner)));
}
// Delays page for ops
await ops.goto(BASE + "/#/delays"); await ops.reload();
await ops.waitForSelector('main h1:text-is("Delays and service guarantee")');
await shot(ops, "46-ops-delays");

// Mobile views of the new screens
const mf = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mfp = await mf.newPage();
mfp.on("pageerror", (e) => errors.push(`mobile founder: ${e.message}`));
await mfp.goto(BASE + "/");
await mfp.locator('button[data-email="founder@mkwadvisors.test"]').click();
await mfp.locator('form[data-form="verify"] button[type="submit"]').click();
await mfp.waitForSelector("#nav a");
for (const [route, name] of [["people", "20-mobile-people"], ["settings", "21-mobile-settings"], ["catalogue", "27-mobile-catalogue"], ["rules", "28-mobile-rules"], ["partners", "33-mobile-partners-runs"], ["scoping", "40-mobile-scoping"], ["agent", "41-mobile-ai-queue"], ["delays", "47-mobile-delays"]]) {
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
await mpp.waitForSelector("#nav a");
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
