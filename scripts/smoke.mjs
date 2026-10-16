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

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${email}: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !m.text().includes("401") && errors.push(`${email} console: ${m.text()}`));
  page.on("dialog", (d) => d.accept(d.type() === "prompt" ? (d.defaultValue() || "REF-12345") : undefined));
  await page.goto(BASE + "/");
  await page.locator(`button[data-email="${email}"]`).click();
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
  log.push("partner sees client price words? " + /client price|margin|AED 4,200/i.test(txt));
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
log.push("client sees phone? " + pageText.includes("123 4567") + " · sees email? " + pageText.includes("ali@example.com"));
log.push("client sees partner cost words? " + /partner cost|margin/i.test(pageText));
await shot(client, "13-client-engagement-approved");

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
log.push("mobile horizontal overflow? " + overflow);
await mp.screenshot({ path: `${OUT}/14-mobile-client.png`, fullPage: false });

// Audit
const founder = await session("founder@mkwadvisors.test");
await founder.goto(BASE + "/#/audit");
await founder.waitForSelector('main h1:text-is("Audit trail")');
log.push("audit: " + (await founder.locator("main p").first().innerText()));
await shot(founder, "15-audit");

writeFileSync(`${OUT}/log.txt`, [...log, "ERRORS:", ...errors].join("\n"));
console.log([...log, "ERRORS:", ...errors].join("\n"));
await browser.close();
