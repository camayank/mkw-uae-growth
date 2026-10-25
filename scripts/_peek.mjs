import { chromium } from "playwright";
const [, , email, out, width = "1280", ...routes] = process.argv;
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const ctx = await b.newContext({ viewport: { width: Number(width), height: 900 } });
const p = await ctx.newPage();
p.on("pageerror", (e) => console.log("pageerror", e.message));
p.on("console", (m) => m.type() === "error" && console.log("console", m.text()));
p.on("dialog", (d) => d.accept());
p.on("response", async (r) => { if (r.status() >= 400) console.log("HTTP", r.status(), r.request().method(), r.url(), (r.request().postData() ?? "").slice(0, 300), (await r.text().catch(() => "")).slice(0, 200)); });
await p.goto("http://localhost:8787/");
await p.locator(`button[data-email="${email}"]`).click();
await p.locator('form[data-form="verify"] button[type="submit"]').click();
await p.waitForSelector("#nav > :is(a, .navgroup)");
let i = 0;
for (const r of routes) {
  if (r.startsWith("click:")) { await p.locator(r.slice(6)).first().click(); await p.waitForTimeout(600); continue; }
  if (r.startsWith("fill:")) { const [sel, val] = r.slice(5).split("="); await p.fill(sel, val); continue; }
  if (r.startsWith("select:")) { const [sel, val] = r.slice(7).split("="); await p.selectOption(sel, val); await p.waitForTimeout(300); continue; }
  if (r === "shot") { await p.waitForTimeout(700); await p.screenshot({ path: `${out}-${i++}.png`, fullPage: true }); continue; }
  await p.goto("http://localhost:8787/" + r); await p.waitForLoadState("networkidle"); await p.waitForTimeout(800);
}
console.log((await p.locator("main").innerText()).slice(0, 1200));
await b.close();
