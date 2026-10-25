import { BRAND_AR, renderTemplateAr } from "./templates-ar.ts";
import { asPlatform, txScope } from "./context.ts";
import { withClock, type Database } from "./db.ts";
import { createDispatcher, emit, InDoubtError, type DispatchSummary, type Topic, type TopicHandler } from "./outbox.ts";
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
  /**
   * Raise a message. Inside a transaction it is written to the outbox in that transaction (O11), so it exists
   * exactly when the change does; it is delivered after the commit.
   */
  send(n: Notification): Promise<void>;
  /** Raise other outbox work (agent drafts) the same way. */
  emit(topic: Exclude<Topic, "notify">, payload: Record<string, unknown>): Promise<void>;
  /** Register the handler for an outbox topic (the document checker registers itself in buildApp). */
  on(topic: Exclude<Topic, "notify">, handler: TopicHandler): void;
  /** Deliver what this process raised so far. Tests call it; the server calls it after each response. */
  flush(): Promise<void>;
  /** A full dispatcher run: recover abandoned claims, then deliver everything due. The jobs runner calls it. */
  dispatch(): Promise<DispatchSummary>;
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

/**
 * The test transport. `failNext` makes the next delivery a refusal; `inDoubtNext` delivers the next message and then
 * fails as a timeout would, so nobody can tell it went.
 */
export function memoryTransport(): Transport & { delivered: OutboundEmail[]; failNext?: string; inDoubtNext?: boolean } {
  const delivered: OutboundEmail[] = [];
  const t: Transport & { delivered: OutboundEmail[]; failNext?: string; inDoubtNext?: boolean } = {
    kind: "memory",
    delivered,
    async deliver(email) {
      if (t.inDoubtNext) {
        t.inDoubtNext = false;
        delivered.push(email);
        throw new InDoubtError("The operation was aborted due to timeout");
      }
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
      // Only a definite refusal (a 4xx answer) is retried. No answer, a dropped connection or a server error means SES
      // may have taken the message: that is "in doubt", and a person decides rather than the email going twice.
      let res: Response;
      let text: string;
      try {
        res = await signedFetch({ ...cfg, service: "ses" }, url, { method: "POST", body, headers: { "content-type": "application/json" } });
        text = await res.text();
      } catch (e) {
        throw new InDoubtError(`no answer from SES: ${(e as Error).message}`);
      }
      if (res.status >= 500) throw new InDoubtError(`SES answered ${res.status}; the message may have been accepted`);
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
 * Records every message and delivers it through the transport. Messages go through the outbox (O11): written in
 * the caller's transaction, delivered by the dispatcher after the commit, retried on a refusal, and never sent twice
 * on their own. Sign-in codes are the exception: the code is never written down, so they are held in memory until
 * the commit and sent once; a lost one is replaced by asking for a new code.
 */
export function recordingNotifier(opts: NotifierOptions): Notifier {
  const sent: Notification[] = [];
  const codes: Notification[] = [];
  let sendingCodes: Promise<void> | null = null;
  const log = opts.log ?? ((m) => console.error(m));
  const db = withClock(opts.db, opts.now);
  const dispatcher = createDispatcher(db, log);

  /**
   * Record and deliver one message. With an outbox id the record is found again on a retry (one record per
   * message) and a refusal is thrown to the dispatcher, which schedules the retry.
   */
  const deliverOne = async (n: Notification, outboxId: number | null) => {
    const to = n.to.trim().toLowerCase();
    const existing = outboxId
      ? (await asPlatform(db, null, (tx) => tx.query<{ id: string; status: string }>("select id, status from notifications where outbox_id = $1", [outboxId]))).rows[0]
      : undefined;
    if (existing && ["sent", "skipped"].includes(existing.status)) return;
    // Who is this? Decides the audience (branding) and whether the row is somebody's in-app notification.
    const user = await asPlatform(db, null, async (tx) =>
      (await tx.query<{ id: string; type: "client" | "partner" | "platform"; status: string; locale: string; arabic: boolean }>("select u.id, o.type, u.status, u.locale, coalesce((select (value->>'reviewed')::boolean from settings where key = 'arabic'), false) or coalesce((select value->'previewEmails' ? u.email from settings where key = 'arabic'), false) as arabic from users u join orgs o on o.id = u.org_id where u.email = $1", [to])).rows[0],
    );
    if (user && user.status !== "active") {
      // Deactivated or erased people receive nothing; the fact is recorded without the wording.
      await asPlatform(db, null, (tx) =>
        existing
          ? tx.query("update notifications set status = 'skipped', error = 'recipient not active', subject = '(recipient not active)', body = '', vars = '{}' where id = $1", [existing.id])
          : tx.query(
              `insert into notifications (user_id, to_email, channel, template, audience, subject, body, vars, in_app, status, error, outbox_id)
               values ($1,$2,$3,$4,'staff','(recipient not active)','','{}',false,'skipped','recipient not active',$5)`,
              [user.id, to, n.channel, n.template, outboxId],
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
    const id = existing
      ? (await asPlatform(db, null, (tx) => tx.query("update notifications set status = 'queued', error = null where id = $1", [existing.id])), existing.id)
      : await asPlatform(db, null, async (tx) =>
          (
            await tx.query<{ id: string }>(
              `insert into notifications (user_id, to_email, channel, template, audience, subject, body, vars, in_app, status, locale, outbox_id)
               values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11) returning id`,
              [user?.id ?? null, to, n.channel, n.template, audience, recordedSubject, recordedBody, JSON.stringify(recordedVars), rendered.inApp && !!user, locale, outboxId],
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
      log(`[notify] delivery ${(e as InDoubtError).inDoubt ? "in doubt" : "failed"} for ${n.template}: ${msg}`);
      // In doubt, the record stays "queued" (handed over, no answer): the outbox marks the message for a person.
      if (!(e as InDoubtError).inDoubt) await asPlatform(db, null, (tx) => tx.query("update notifications set status = 'failed', error = $2 where id = $1", [id, msg]));
      if (outboxId) throw e;
    }
  };

  dispatcher.on("notify", {
    handle: (row) => deliverOne(row.payload as unknown as Notification, row.id),
    // An abandoned claim: the record says whether the provider took the message. "queued" means it was handed over
    // with no answer recorded, so nobody can say whether it went: a person decides.
    async check(row) {
      const n = (await asPlatform(db, null, (tx) => tx.query<{ status: string }>("select status from notifications where outbox_id = $1", [row.id]))).rows[0];
      if (!n || n.status === "failed") return "not_done";
      if (n.status === "queued") return "unknown";
      return "done";
    },
  });

  const sendCodes = (): Promise<void> => {
    if (sendingCodes) return sendingCodes;
    const run = (async () => {
      while (codes.length) {
        const n = codes.shift()!;
        await deliverOne(n, null).catch((e) => log(`[notify] could not record ${n.template}: ${(e as Error).message}`));
      }
    })().finally(() => {
      if (sendingCodes === run) sendingCodes = null;
    });
    sendingCodes = run;
    return run;
  };

  const track = (n: Notification) => {
    sent.push(n);
    if (sent.length > 500) sent.shift();
  };

  return {
    sent,
    async send(n) {
      track(n);
      if (n.template === "login_code") {
        // Held until the commit (see context.ts), then sent once; never written to the outbox.
        const hold = () => {
          codes.push(n);
          setImmediate(() => void sendCodes());
        };
        const scope = txScope.getStore();
        if (scope) scope.deferred.push({ run: hold });
        else hold();
        return;
      }
      await emit(db, "notify", n as unknown as Record<string, unknown>, () => dispatcher.kick());
    },
    async emit(topic, payload) {
      await emit(db, topic, payload, () => dispatcher.kick());
    },
    on(topic, handler) {
      dispatcher.on(topic, handler);
    },
    async flush() {
      await sendCodes();
      await dispatcher.runIfDirty();
    },
    async dispatch() {
      await sendCodes();
      return dispatcher.run();
    },
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
    async emit(topic) {
      log(`[notify] ${topic} event (no dispatcher in this process)`);
    },
    on() {},
    async flush() {},
    async dispatch() {
      return { done: 0, retried: 0, failed: 0, unknown: 0, recovered: 0 };
    },
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
