import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E14 (D96): the public homepage is the front door at `/`; the workspace lives at `/app/`; old addresses keep working;
 * an unknown address is a 404 page, not the workspace; search engines are pointed at the public pages only.
 */
const WEB = fileURLToPath(new URL("../../web/public", import.meta.url));

describe("the front door and the workspace's address (E14)", () => {
  let env: TestEnv;
  let bare: TestEnv;
  const get = async (e: TestEnv, url: string) => {
    const r = await e.app.inject({ method: "GET", url });
    return { status: r.statusCode, body: r.body, type: String(r.headers["content-type"] ?? ""), location: r.headers.location as string | undefined };
  };

  beforeAll(async () => {
    env = await makeEnv(undefined, { webDir: WEB, appUrl: "https://tasees.test/" });
    bare = await makeEnv(undefined, { webDir: WEB });
  });
  afterAll(async () => {
    await env.db.close();
    await bare.db.close();
  });

  it("/ is the public homepage, with its full canonical address once APP_URL is set", async () => {
    const home = await get(env, "/");
    expect(home.status).toBe(200);
    expect(home.type).toMatch(/text\/html/);
    expect(home.body).toContain('id="quick-start"');
    expect(home.body).toContain('<link rel="canonical" href="https://tasees.test/" />');
    expect(home.body).toContain('<script src="forward.js"></script>');
    // The homepage's script is loaded by forward.js, so a forwarded old link never runs it.
    expect(home.body).not.toContain('src="selector.js"');
    expect((await get(env, "/forward.js")).body).toContain('s.src = "selector.js"');
    // Without APP_URL the canonical link stays relative.
    expect((await get(bare, "/")).body).toContain('<link rel="canonical" href="/" />');
    const intake = await get(env, "/intake.html");
    expect(intake.status).toBe(200);
    expect(intake.body).toContain('<link rel="canonical" href="https://tasees.test/intake.html" />');
  });

  it("the workspace is at /app/, its files load from there, and it is not for indexing", async () => {
    const app = await get(env, "/app/");
    expect(app.status).toBe(200);
    expect(app.body).toContain("<title>Tasees workspace</title>");
    expect(app.body).toContain('<meta name="robots" content="noindex" />');
    expect(app.body).not.toContain("canonical");
    for (const [url, type] of [["/app/styles.css", /text\/css/], ["/app/tokens.css", /text\/css/], ["/app/app.js", /javascript/], ["/app/js/core.js", /javascript/]] as const) {
      const r = await get(env, url);
      expect(r.status, url).toBe(200);
      expect(r.type, url).toMatch(type);
    }
    // The homepage's own files are at the root.
    expect((await get(env, "/selector.js")).type).toMatch(/javascript/);
    expect((await get(env, "/forward.js")).body).toContain('location.replace("/app/" + location.hash)');
  });

  it("old addresses redirect permanently, keeping the query (a saved result's code)", async () => {
    expect(await get(env, "/selector.html?code=ABCDE23456&lang=ar")).toMatchObject({ status: 301, location: "/?code=ABCDE23456&lang=ar" });
    expect(await get(env, "/selector.html")).toMatchObject({ status: 301, location: "/" });
    expect(await get(env, "/index.html")).toMatchObject({ status: 301, location: "/app/" });
    expect(await get(env, "/app")).toMatchObject({ status: 301, location: "/app/" });
  });

  it("an unknown address is a 404 page, never the workspace; nothing outside the web folder is served", async () => {
    const missing = await get(env, "/pricing");
    expect(missing.status).toBe(404);
    expect(missing.body).toContain("We could not find that page");
    expect(missing.body).not.toContain("<title>Tasees workspace</title>");
    // The 404 page is served only as a 404, however the path is written.
    for (const url of ["/404.html", "/./404.html", "/js/../404.html", "/app/404.html"]) {
      const r = await get(env, url);
      expect([r.status, r.body.includes("We could not find that page") || r.body.includes("<title>Tasees workspace</title>")], url).toEqual([url.startsWith("/app/") ? 200 : 404, true]);
    }
    // apps/api/package.json exists two folders above the web folder: no spelling of the path reaches it.
    for (const url of ["/%2e%2e/%2e%2e/api/package.json", "/app/%2e%2e/%2e%2e/%2e%2e/api/package.json", "/..%2f..%2fapi%2fpackage.json", "/%252e%252e/%252e%252e/api/package.json", "/..%5c..%5capi%5cpackage.json", "/app/..%2f..%2f..%2fapi%2fpackage.json"]) {
      const r = await get(env, url);
      expect(r.body, url).not.toContain('"@tasees/api"');
      expect(r.status === 404 || r.body.includes("<title>Tasees workspace</title>"), url).toBe(true);
    }
    // The public pages are served at the root only: under /app/ the path is the workspace's.
    for (const url of ["/app/selector.html", "/app/intake.html"]) expect((await get(env, url)).body, url).toContain("<title>Tasees workspace</title>");
    // Under /app/ an unknown path is the workspace (its routes are in the fragment), as before.
    expect((await get(env, "/app/anything")).body).toContain("<title>Tasees workspace</title>");
    // The API keeps its JSON 404.
    expect(await get(env, "/api/nope")).toMatchObject({ status: 404 });
    expect(JSON.parse((await get(env, "/api/nope")).body)).toMatchObject({ error: "not_found" });
  });

  it("robots.txt keeps the workspace and the API out of search; the sitemap lists the public pages", async () => {
    const robots = await get(env, "/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.body).toBe("User-agent: *\nDisallow: /app/\nDisallow: /api/\nSitemap: https://tasees.test/sitemap.xml\n");
    expect((await get(bare, "/robots.txt")).body).not.toContain("Sitemap");
    const map = await get(env, "/sitemap.xml");
    expect(map.status).toBe(200);
    expect(map.type).toMatch(/xml/);
    expect(map.body).toContain("<loc>https://tasees.test/</loc>");
    expect(map.body).toContain("<loc>https://tasees.test/intake.html</loc>");
    expect(map.body).not.toContain("/app/");
    expect((await get(bare, "/sitemap.xml")).status).toBe(404);
  });

  it("the links the platform sends open the workspace at /app/", async () => {
    // A client's request becomes an offer; the email links to it in the workspace.
    const req = await env.call("client", "POST", "/api/requests", { answers: { mode: "new_company", jurisdiction: "free_zone", emirate: "Dubai", visas: 1 } });
    const built = await env.call("ops", "POST", `/api/ops/requests/${req.body.id}/build-offers`, { tiers: ["standard"] });
    await env.call("ops", "POST", `/api/ops/offers/${built.body.offerIds[0]}/publish`);
    const links = env.emails.flatMap((m) => m.text.match(/https:\/\/app\.test\/[^\s"<)]*/g) ?? []);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l, l).toMatch(/^https:\/\/app\.test\/app\/#\//);
  });
});
