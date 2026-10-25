/**
 * Every environment variable the API reads, with its rule (O13). The server, the jobs runner and the scripts call
 * `checkConfig()` before anything else and refuse to start on any problem. Messages name the variable and the rule
 * broken, never the value: a misplaced secret must not end up in a log. The adapters keep reading their own variables
 * (`notifierFromEnv`, `storageFromEnv`, ...); this file only decides whether the set makes sense.
 */
import { z } from "zod";

type Rule = { test: (v: string) => boolean; rule: string };

const oneOf = (...values: string[]): Rule => ({ test: (v) => values.includes(v), rule: `must be one of ${values.join(", ")}` });
const wholeNumber = (min: number, max: number): Rule => ({
  test: (v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max,
  rule: `must be a whole number from ${min} to ${max}`,
});
const url = (...protocols: string[]): Rule => ({
  test: (v) => {
    try {
      return protocols.includes(new URL(v).protocol);
    } catch {
      return false;
    }
  },
  rule: `must be a ${protocols.map((p) => p.replace(":", "")).join(" or ")} URL`,
});
const email: Rule = { test: (v) => z.string().email().safeParse(v).success, rule: "must be an email address" };
const text: Rule = { test: (v) => v.trim().length > 0, rule: "must not be blank when set" };

/** The variables and their rules when set. Anything else in the environment is ignored. */
export const CONFIG_RULES: Record<string, Rule> = {
  // "demo" is the throw-away demo stack (infra/lib/demo-stack.ts): not production, so development sign-in is allowed.
  NODE_ENV: oneOf("development", "production", "test", "demo"),
  HOST: text,
  PORT: wholeNumber(1, 65535),
  TRUST_PROXY: wholeNumber(0, 10),
  LOG: oneOf("0", "1"),
  DEV_LOGIN: oneOf("0", "1"),
  IN_PROCESS_JOBS: oneOf("0", "1"),
  DATABASE_URL: url("postgres:", "postgresql:"),
  PGLITE_DIR: text,
  UPLOAD_DIR: text,
  WEB_DIR: text,
  APP_URL: url("http:", "https:"),
  EMAIL: oneOf("console", "ses"),
  EMAIL_FROM_CLIENT: email,
  EMAIL_FROM_PARTNER: email,
  ALERT_EMAIL: email,
  SES_REGION: text,
  SES_ENDPOINT: url("https:", "http:"),
  SES_ACCESS_KEY_ID: text,
  SES_SECRET_ACCESS_KEY: text,
  SES_SESSION_TOKEN: text,
  STORAGE: oneOf("local", "s3"),
  S3_BUCKET: text,
  S3_REGION: text,
  S3_ENDPOINT: url("https:", "http:"),
  S3_FORCE_PATH_STYLE: oneOf("0", "1"),
  S3_PREFIX: { test: () => true, rule: "" },
  S3_SSE: oneOf("AES256", "aws:kms"),
  S3_KMS_KEY_ID: text,
  S3_ACCESS_KEY_ID: text,
  S3_SECRET_ACCESS_KEY: text,
  S3_SESSION_TOKEN: text,
  PAYMENT_WEBHOOK_SECRET: text,
};

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(public readonly problems: string[]) {
    super(`Configuration refused:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
}

/** The problems with an environment, as "NAME: rule" lines (empty when it is fine). Never includes a value. */
export function configProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const set = (k: string) => env[k] !== undefined && env[k] !== "";
  for (const [name, r] of Object.entries(CONFIG_RULES)) {
    if (set(name) && !r.test(env[name]!)) problems.push(`${name}: ${r.rule}`);
  }
  const need = (name: string, why: string) => {
    if (!set(name)) problems.push(`${name}: required ${why}`);
  };
  if (env.EMAIL === "ses") {
    need("EMAIL_FROM_CLIENT", "when EMAIL=ses");
    need("EMAIL_FROM_PARTNER", "when EMAIL=ses");
    if (!set("SES_REGION") && !set("S3_REGION")) problems.push("SES_REGION: required when EMAIL=ses (or S3_REGION)");
  }
  if (env.STORAGE === "s3") {
    need("S3_BUCKET", "when STORAGE=s3");
    need("S3_REGION", "when STORAGE=s3");
  }
  if (env.S3_SSE === "aws:kms") need("S3_KMS_KEY_ID", "when S3_SSE=aws:kms");
  if (env.NODE_ENV === "production") {
    // Unset rejects every webhook, which is safe; a short one could be guessed.
    if (set("PAYMENT_WEBHOOK_SECRET") && env.PAYMENT_WEBHOOK_SECRET!.length < 16) {
      problems.push("PAYMENT_WEBHOOK_SECRET: at least 16 characters in production");
    }
    if (env.DEV_LOGIN === "1") problems.push("DEV_LOGIN: must not be 1 in production (sign-in codes would be shown on screen)");
    if (set("APP_URL") && !env.APP_URL!.startsWith("https://")) problems.push("APP_URL: must be https in production");
  }
  return problems;
}

/** Refuse to go on with a bad configuration. Call first thing in every entry point. */
export function checkConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = configProblems(env);
  if (problems.length) throw new ConfigError(problems);
}

/** For entry points: print the problems and exit 1 instead of a stack trace. */
export function checkConfigOrExit(env: NodeJS.ProcessEnv = process.env): void {
  try {
    checkConfig(env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
