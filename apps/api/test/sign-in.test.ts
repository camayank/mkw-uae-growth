import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asPlatform } from "../src/lib/context.ts";
import { makeEnv, type TestEnv } from "./helpers.ts";

/**
 * E17: signing in by one-time code. A wrong code counts against the code even though the request fails (the count used
 * to roll back with the error, so the five-guess limit never held); guesses sent at the same moment cannot get past
 * the limit; and every failure reads the same, so the answer never tells whether an email has an account.
 */
const EMAIL = "founder@sample-client.test";
// Codes are limited to five an hour per email: this file issues exactly five for EMAIL, so a new test needing more
// codes should use another seeded account.

describe("sign-in codes (E17)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    // Each test signs in from its own address (through the trusted proxy), so the per-address throttle on the
    // verify endpoint stays out of the way of what these tests measure: the per-code limit.
    env = await makeEnv(undefined, { trustProxy: "127.0.0.1" });
  });
  afterAll(() => env.db.close());

  let ip = "203.0.113.1";
  const request = async (email = EMAIL) => (await env.send("anon", "POST", "/api/auth/request-code", { email }, { "x-forwarded-for": ip })).body as { devCode?: string };
  const verify = (code: string, email = EMAIL) => env.send("anon", "POST", "/api/auth/verify", { email, code }, { "x-forwarded-for": ip });
  const attempts = async () => (await asPlatform(env.db, null, (tx) => tx.query<{ attempts: number }>("select attempts from login_codes where email = $1 order by expires_at desc limit 1", [EMAIL]))).rows[0]!.attempts;
  const wrong = (code: string) => (code === "000000" ? "111111" : "000000");

  it("a wrong code is counted, and after five the right code no longer signs in", async () => {
    ip = "203.0.113.1";
    const { devCode } = await request();
    for (let i = 1; i <= 5; i++) {
      expect((await verify(wrong(devCode!))).status).toBe(401);
      expect(await attempts()).toBe(i);
    }
    const late = await verify(devCode!);
    expect(late.status).toBe(401);
    expect(late.body.token).toBeUndefined();
    // A new code works again.
    const fresh = await request();
    expect((await verify(fresh.devCode!)).status).toBe(200);
  });

  it("guesses sent at the same moment cannot get past five", async () => {
    ip = "203.0.113.2";
    const { devCode } = await request();
    const results = await Promise.all(Array.from({ length: 12 }, () => verify(wrong(devCode!))));
    expect(results.every((r) => r.status === 401)).toBe(true);
    expect(await attempts()).toBe(5);
    expect((await verify(devCode!)).status).toBe(401);
  });

  it("the right code signs in once; a used code does not sign in again", async () => {
    ip = "203.0.113.3";
    const { devCode } = await request();
    expect((await verify(wrong(devCode!))).status).toBe(401);
    const ok = await verify(devCode!);
    expect(ok.status).toBe(200);
    expect(typeof ok.body.token).toBe("string");
    expect((await verify(devCode!)).status).toBe(401);
  });

  it("only the newest code counts: once it is used or spent, an older code still alive cannot be guessed (independent review of E17)", async () => {
    ip = "203.0.113.5";
    const other = "accounts@sample-client.test";
    // Two live codes for one email, as two requests at the same moment could once leave (issuing is now one at a time).
    const older = (await request(other)).devCode!;
    await asPlatform(env.db, null, (tx) => tx.query("update login_codes set used_at = null where email = $1", [other]));
    const newer = (await request(other)).devCode!;
    await asPlatform(env.db, null, (tx) => tx.query("update login_codes set used_at = null where email = $1", [other]));
    expect((await verify(newer, other)).status).toBe(200);
    expect((await verify(older, other)).status).toBe(401);
  });

  it("every failure reads the same: a wrong code, a used or spent code, an email with no account", async () => {
    ip = "203.0.113.4";
    const { devCode } = await request();
    const wrongCode = await verify(wrong(devCode!));
    const noAccount = await verify("123456", "nobody-at-all@example.test");
    for (let i = 0; i < 5; i++) await verify(wrong(devCode!));
    const spent = await verify(devCode!);
    const answers = [wrongCode, noAccount, spent].map((r) => `${r.status} ${JSON.stringify(r.body)}`);
    expect(new Set(answers).size, answers.join(" / ")).toBe(1);
  });
});
