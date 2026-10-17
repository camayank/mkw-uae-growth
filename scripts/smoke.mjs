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
log.push("retention UNCERTAIN badges before: " + (await founder.locator('.badge:text-is("UNCERTAIN")').count()));
await shot(founder, "18-settings-retention");
await founder.fill('form[data-form="retention"] input[name="note"]', "Smoke test: confirmed by the founder");
await founder.locator('form[data-form="retention"] button[type="submit"]').click();
await founder.waitForTimeout(800);
log.push("retention: " + (await toastText(founder)));
check("no UNCERTAIN retention badge after the founder confirms:", (await founder.locator('.badge:text-is("UNCERTAIN")').count()) === 0);
await shot(founder, "19-settings-retention-confirmed");
await finance.goto(BASE + "/#/settings"); await finance.reload();
await finance.waitForSelector("main h1");
check("finance cannot confirm retention periods:", (await finance.locator('form[data-form="retention"] button[type="submit"]').count()) === 0);
const logText = await finance.locator("main").innerText();
check("delivery log lists sent messages for client and partner audiences:", /Delivery log/.test(logText) && /offer ready/i.test(logText) && /allocation offered/i.test(logText));

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
await ops.waitForSelector('main h1:text-is("Pricing rules and government fees")');
check("ops sees rules but cannot schedule, verify or change settings:", (await ops.locator('form[data-form="rule"], form[data-form="pricing-settings"], button[data-act="fee-verify"]').count()) === 0 && (await ops.locator('form[data-form="fee"]').count()) === 1);

// Mobile views of the new screens
const mf = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const mfp = await mf.newPage();
mfp.on("pageerror", (e) => errors.push(`mobile founder: ${e.message}`));
await mfp.goto(BASE + "/");
await mfp.locator('button[data-email="founder@mkwadvisors.test"]').click();
await mfp.locator('form[data-form="verify"] button[type="submit"]').click();
await mfp.waitForSelector("#nav a");
for (const [route, name] of [["people", "20-mobile-people"], ["settings", "21-mobile-settings"], ["catalogue", "27-mobile-catalogue"], ["rules", "28-mobile-rules"]]) {
  await mfp.goto(BASE + "/#/" + route); await mfp.reload();
  await mfp.waitForSelector("main h1");
  await mfp.waitForTimeout(600);
  const over = await mfp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check(`${route} at 390 px has no horizontal overflow:`, !over);
  await mfp.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
}

writeFileSync(`${OUT}/log.txt`, [...log, "ERRORS:", ...errors].join("\n"));
console.log([...log, "ERRORS:", ...errors].join("\n"));
await browser.close();
if (errors.length) {
  console.error(`SMOKE TEST FAILED: ${errors.length} error(s)`);
  process.exitCode = 1;
} else {
  console.log("SMOKE TEST PASSED");
}
