import { BRAND_AR, renderTemplateAr } from "./templates-ar.ts";
import { asPlatform, txScope } from "./context.ts";
import { withClock, type Database } from "./db.ts";
import { signedFetch, type AwsCredentials } from "./sigv4.ts";
import { renderTemplate, TEMPLATE_AUDIENCE, BRAND, type Audience, type TemplateName, type Vars } from "./templates.ts";

/**
 * Outbound messages. Every send is a named template with typed variables, never free text from users.
 *
 *   Notifier   what the application calls: send() queues, flush() records and delivers after the caller's
 *              transaction has finished, so a rolled-back change never produces an email.
 *   Transport  how an email leaves: memory (tests), console (development), Amazon SES (production).
 *   Record     every message lands in the notifications table with its delivery result; rows addressed to a
 *              known user are that user's in-app bell.
 */
export interface Notification {
  to: string;
  channel: "email" | "whatsapp";
  template: TemplateName;
  vars: Vars;
  /** Overrides the audience derived from the template or the recipient's organisation. */
  audience?: Audience;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
  /** Deliver everything queued so far. Tests call it; the server calls it after each request. */
  flush(): Promise<void>;
  /** Everything handed to send(), oldest first (last 500). */
  sent: Notification[];
}

export interface OutboundEmail {
  to: string;
  from: string;
  fromName: string;
  subject: string;
  text: string;
}

export interface Transport {
  kind: string;
  deliver(email: OutboundEmail): Promise<{ providerRef: string }>;
}

export function memoryTransport(): Transport & { delivered: OutboundEmail[]; failNext?: string } {
  const delivered: OutboundEmail[] = [];
  const t: Transport & { delivered: OutboundEmail[]; failNext?: string } = {
    kind: "memory",
    delivered,
    async deliver(email) {
      if (t.failNext) {
        const msg = t.failNext;
        t.failNext = undefined;
        throw new Error(msg);
      }
      delivered.push(email);
      return { providerRef: `mem-${delivered.length}` };
    },
  };
  return t;
}

export function consoleTransport(log: (msg: string) => void = console.log): Transport {
  let n = 0;
  return {
    kind: "console",
    async deliver(email) {
      n += 1;
      // Logs are read by more people than a mailbox: a sign-in code never reaches them (development shows the code
      // on screen with DEV_LOGIN instead). Standalone six-digit runs (the code's length, D11) in the subject are
      // masked; document numbers such as TI-2026-000001 are not.
      log(`[email] to ${email.to} from "${email.fromName}" <${email.from}>: ${email.subject.replace(/(?<![\w-])\d{6}(?![\w-])/g, "••••••")}`);
      return { providerRef: `console-${n}` };
    },
  };
}

export interface SesConfig extends AwsCredentials {
  region: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Amazon SES v2 SendEmail over HTTPS, signed with SigV4. No SDK. */
export function sesTransport(cfg: SesConfig): Transport {
  for (const k of ["region", "accessKeyId", "secretAccessKey"] as const) if (!cfg[k]) throw new Error(`SES transport needs ${k}`);
  const endpoint = new URL(cfg.endpoint ?? `https://email.${cfg.region}.amazonaws.com`);
  return {
    kind: "ses",
    async deliver(email) {
      const url = new URL("/v2/email/outbound-emails", endpoint);
      const body = JSON.stringify({
        // RFC 5322: a display name with a comma ("Tasees, by MKW Advisors") must be quoted.
        FromEmailAddress: `"${email.fromName.replace(/["\\]/g, "")}" <${email.from}>`,
        Destination: { ToAddresses: [email.to] },
        Content: {
          Simple: {
            Subject: { Data: email.subject, Charset: "UTF-8" },
            Body: { Text: { Data: email.text, Charset: "UTF-8" } },
          },
        },
      });
      const res = await signedFetch({ ...cfg, service: "ses" }, url, { method: "POST", body, headers: { "content-type": "application/json" } });
      const text = await res.text();
      if (!res.ok) {
        let code = String(res.status);
        try {
          code = (JSON.parse(text) as { message?: string }).message ?? code;
        } catch {
          /* keep the status */
        }
        throw new Error(`SES refused the message: ${code}`);
      }
      const ref = (JSON.parse(text) as { MessageId?: string }).MessageId ?? "unknown";
      return { providerRef: ref };
    },
  };
}

export interface NotifierOptions {
  db: Database;
  transport: Transport;
  /** Base URL used in links, for example https://app.tasees.ae */
  appUrl: string;
  fromClient: string;
  fromPartner: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

/**
 * Records every message and delivers it through the transport, after the calling transaction has finished.
 * The record is written in its own transaction: a delivery failure marks the row failed and never throws
 * into business code.
 */
export function recordingNotifier(opts: NotifierOptions): Notifier {
  const sent: Notification[] = [];
  const queue: Notification[] = [];
  let flushing: Promise<void> | null = null;
  const log = opts.log ?? ((m) => console.error(m));
  const db = withClock(opts.db, opts.now);

  const deliverOne = async (n: Notification) => {
    const to = n.to.trim().toLowerCase();
    // Who is this? Decides the audience (branding) and whether the row is somebody's in-app notification.
    const user = await asPlatform(db, null, async (tx) =>
      (await tx.query<{ id: string; type: "client" | "partner" | "platform"; status: string; locale: string; arabic: boolean }>("select u.id, o.type, u.status, u.locale, coalesce((select (value->>'reviewed')::boolean from settings where key = 'arabic'), false) or coalesce((select value->'previewEmails' ? u.email from settings where key = 'arabic'), false) as arabic from users u join orgs o on o.id = u.org_id where u.email = $1", [to])).rows[0],
    );
    if (user && user.status !== "active") {
      // Deactivated or erased people receive nothing; the fact is recorded without the wording.
      await asPlatform(db, null, (tx) =>
        tx.query(
          `insert into notifications (user_id, to_email, channel, template, audience, subject, body, vars, in_app, status, error)
           values ($1,$2,$3,$4,'staff','(recipient not active)','','{}',false,'skipped','recipient not active')`,
          [user.id, to, n.channel, n.template],
        ),
      );
      return;
    }
    const fromOrg: Audience | undefined = user ? (user.type === "client" ? "client" : user.type === "partner" ? "partner" : "staff") : undefined;
    const templateAudience = TEMPLATE_AUDIENCE[n.template];
    const audience: Audience = n.audience ?? (templateAudience === "any" ? (fromOrg ?? "client") : templateAudience);
    // Arabic only for a client who chose it, and only once the reviewer's sign-off is recorded (staff may
    // preview). Templates without an Arabic version fall back to English.
    const wantsArabic = !!user && user.locale === "ar" && audience === "client" && (user.arabic || user.type === "platform");
    const arabic = wantsArabic ? renderTemplateAr(n.template, n.vars, opts.appUrl) : null;
    const locale: "en" | "ar" = arabic ? "ar" : "en";
    const rendered = arabic ?? renderTemplate(n.template, audience, n.vars, opts.appUrl);
    const from = audience === "client" ? opts.fromClient : opts.fromPartner;
    // A secret (sign-in code) is never written down: the record keeps who, what kind and whether it was sent.
    const recordedSubject = rendered.secret ? "(sign-in code: not recorded)" : rendered.subject;
    const recordedBody = rendered.secret ? "" : rendered.body;
    const recordedVars = rendered.secret ? {} : n.vars;
    const id = await asPlatform(db, null, async (tx) =>
      (
        await tx.query<{ id: string }>(
          `insert into notifications (user_id, to_email, channel, template, audience, subject, body, vars, in_app, status, locale)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10) returning id`,
          [user?.id ?? null, to, n.channel, n.template, audience, recordedSubject, recordedBody, JSON.stringify(recordedVars), rendered.inApp && !!user, locale],
        )
      ).rows[0]!.id,
    );
    if (n.channel !== "email") {
      await asPlatform(db, null, (tx) => tx.query("update notifications set status = 'skipped', error = 'channel not available yet' where id = $1", [id]));
      return;
    }
    try {
      const { providerRef } = await opts.transport.deliver({ to, from, fromName: locale === "ar" ? BRAND_AR.name : BRAND[audience].name, subject: rendered.subject, text: rendered.body });
      await asPlatform(db, null, (tx) => tx.query("update notifications set status = 'sent', provider_ref = $2, sent_at = app_now() where id = $1", [id, providerRef]));
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      log(`[notify] delivery failed for ${n.template} to ${to}: ${msg}`);
      await asPlatform(db, null, (tx) => tx.query("update notifications set status = 'failed', error = $2 where id = $1", [id, msg]));
    }
  };

  const drain = async () => {
    while (queue.length) {
      const n = queue.shift()!;
      try {
        await deliverOne(n);
      } catch (e) {
        log(`[notify] could not record ${n.template} to ${n.to}: ${(e as Error).message}`);
      }
    }
  };
  const flush = (): Promise<void> => {
    if (flushing) return flushing;
    // Clear the marker only when the drain has finished, never before the assignment below completes.
    const run = drain().finally(() => {
      if (flushing === run) flushing = null;
    });
    flushing = run;
    return run;
  };

  const enqueue = (n: Notification) => {
    sent.push(n);
    if (sent.length > 500) sent.shift();
    if (queue.length >= 10_000) {
      log(`[notify] queue full, dropping ${n.template} to ${n.to}`);
      return;
    }
    queue.push(n);
    // Deliver once the current request has finished; never inside the caller's transaction.
    setImmediate(() => void flush());
  };

  return {
    sent,
    async send(n) {
      // Inside a transaction: hold the message until that transaction has committed (see context.ts).
      const scope = txScope.getStore();
      if (scope) scope.push({ run: () => enqueue(n) });
      else enqueue(n);
    },
    flush,
  };
}

/** Development fallback with no database record: prints each message. Kept for scripts. */
export function consoleNotifier(log: (msg: string) => void = console.log): Notifier {
  const sent: Notification[] = [];
  return {
    sent,
    async send(n) {
      sent.push(n);
      if (sent.length > 500) sent.shift();
      log(`[notify] ${n.channel} ${n.template} -> ${n.to} ${JSON.stringify(n.vars)}`);
    },
    async flush() {},
  };
}

/** The production notifier: recorded in the database, delivered by the transport the environment names. */
export function notifierFromEnv(db: Database, env: NodeJS.ProcessEnv = process.env): { notify: Notifier; transport: Transport } {
  const transport = transportFromEnv(env);
  const notify = recordingNotifier({
    db,
    transport,
    appUrl: env.APP_URL ?? `http://localhost:${env.PORT ?? 8787}`,
    fromClient: env.EMAIL_FROM_CLIENT ?? "tasees@mkwadvisors.com",
    fromPartner: env.EMAIL_FROM_PARTNER ?? "partners@mkwadvisors.com",
  });
  return { notify, transport };
}

/** Pick the transport from the environment. `EMAIL=ses` needs the AWS variables; anything else prints. */
export function transportFromEnv(env: NodeJS.ProcessEnv = process.env): Transport {
  if (env.EMAIL === "ses") {
    return sesTransport({
      region: env.SES_REGION ?? env.S3_REGION ?? "me-central-1",
      accessKeyId: env.SES_ACCESS_KEY_ID ?? env.S3_ACCESS_KEY_ID ?? "",
      secretAccessKey: env.SES_SECRET_ACCESS_KEY ?? env.S3_SECRET_ACCESS_KEY ?? "",
      sessionToken: env.SES_SESSION_TOKEN || undefined,
      endpoint: env.SES_ENDPOINT || undefined,
    });
  }
  return consoleTransport();
}
