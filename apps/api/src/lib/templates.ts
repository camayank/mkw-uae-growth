/**
 * Message wording. Every message is a named template with typed variables; no free text typed by a user is
 * ever placed in a message. Branding follows the audience:
 *   client   from "Tasees, by MKW Advisors"
 *   partner  from "MKW Advisors" / "MKW Advisors Partner Network"; the name Tasees never appears
 *   staff    from "MKW Advisors"
 * The wording below is the English set for owner approval (O2); Arabic follows in O9.
 */

export type Audience = "client" | "partner" | "staff";

export type TemplateName =
  | "login_code"
  | "offer_ready"
  | "payment_due"
  | "allocation_offered"
  | "allocation_reassigned"
  | "milestone_ready_for_review"
  | "milestone_qa_rejected"
  | "change_order_to_approve"
  | "payout_released"
  | "user_invited"
  | "ops_digest"
  | "ops_alert"
  | "invoice_issued"
  | "payout_remittance"
  | "intake_received"
  | "intake_signin"
  | "partner_status_changed"
  | "partner_document_reviewed"
  | "licence_expiring"
  | "licence_expired"
  | "documents_requested"
  | "documents_complete"
  | "step_delayed_client"
  | "step_delayed_partner"
  | "guarantee_credit"
  | "rating_received"
  | "obligation_reminder";

export type Vars = Record<string, string | number | undefined>;

export interface Rendered {
  subject: string;
  body: string;
  /** Shown in the recipient's in-app bell. Sign-in codes are email-only. */
  inApp: boolean;
  /** Contains a secret (a sign-in code): the record keeps the fact of the send, never the wording or variables. */
  secret?: boolean;
}

/** The audience a template is written for; "any" means it depends on who receives it. */
export const TEMPLATE_AUDIENCE: Record<TemplateName, Audience | "any"> = {
  login_code: "any",
  offer_ready: "client",
  payment_due: "client",
  allocation_offered: "partner",
  allocation_reassigned: "partner",
  milestone_ready_for_review: "client",
  milestone_qa_rejected: "partner",
  change_order_to_approve: "client",
  payout_released: "partner",
  user_invited: "any",
  ops_digest: "staff",
  ops_alert: "staff",
  invoice_issued: "client",
  payout_remittance: "partner",
  intake_received: "client",
  intake_signin: "client",
  partner_status_changed: "partner",
  partner_document_reviewed: "partner",
  licence_expiring: "any",
  licence_expired: "any",
  documents_requested: "client",
  documents_complete: "partner",
  step_delayed_client: "client",
  step_delayed_partner: "partner",
  guarantee_credit: "client",
  rating_received: "partner",
  obligation_reminder: "client",
};

export const BRAND: Record<Audience, { name: string; signOff: string }> = {
  client: { name: "Tasees, by MKW Advisors", signOff: "Tasees, by MKW Advisors" },
  partner: { name: "MKW Advisors", signOff: "MKW Advisors Partner Network" },
  staff: { name: "MKW Advisors", signOff: "MKW Advisors" },
};

const aed = (fils: unknown) => {
  const n = Number(fils ?? 0) / 100;
  return "AED " + n.toLocaleString("en-AE", { minimumFractionDigits: n % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
};
const when = (iso: unknown) =>
  iso ? new Date(String(iso)).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Dubai" }) + " GST" : "";
const roleWords = (r: unknown) => String(r ?? "").replace(/_/g, " ");

/** Short reference shown instead of a full id, so a message never carries a whole database key. */
const ref = (id: unknown) => String(id ?? "").slice(0, 8).toUpperCase();

export function renderTemplate(template: TemplateName, audience: Audience, vars: Vars, appUrl: string): Rendered {
  const brand = BRAND[audience];
  const link = (path: string) => `${appUrl.replace(/\/$/, "")}/#${path}`;
  const sign = `\n\n${brand.signOff}`;
  switch (template) {
    case "login_code":
      return {
        inApp: false,
        secret: true,
        subject: `${vars.code} is your ${brand.name} sign-in code`,
        body: `Your sign-in code is ${vars.code}. It works for 10 minutes and only once.\n\nIf you did not ask for a code, you can ignore this email.${sign}`,
      };
    case "offer_ready":
      return {
        inApp: true,
        subject: "Your offers are ready",
        body: `We have priced your request and your offers are ready to review. Open ${link(`/offer/${vars.offerId}`)} to compare them and accept the one that suits you.\n\nEach offer shows one clear price, with VAT and government fees listed separately.${sign}`,
      };
    case "payment_due":
      return {
        inApp: true,
        subject: vars.kind === "balance" ? `Balance of ${aed(vars.amountFils)} due on completion` : `Deposit of ${aed(vars.amountFils)} to start your engagement`,
        body:
          (vars.kind === "balance"
            ? `Your engagement is complete. The balance of ${aed(vars.amountFils)} (the second half of the professional fees) is now due.`
            : `Thank you for accepting your offer. To start the work, please pay the deposit of ${aed(vars.amountFils)}: half of the professional fees plus all government fees, which we pass on at cost.`) +
          `\n\nPay by bank transfer to MKW Advisors quoting reference ${ref(vars.engagementId)}${vars.payUrl ? `, or by card at ${vars.payUrl}` : ""}. Your engagement: ${link(`/engagement/${vars.engagementId}`)}.${sign}`,
      };
    case "allocation_offered":
      return {
        inApp: true,
        subject: "New work from MKW Advisors: reply within 4 working hours",
        body: `MKW Advisors has work for your firm. Please accept or decline by ${when(vars.deadline)} at ${link("/home")}. The brief, your payout and the steps are shown there.\n\nIf we do not hear from you by the deadline, the work is offered to another firm in the network.${sign}`,
      };
    case "allocation_reassigned":
      return {
        inApp: true,
        subject: "Work reassigned",
        body: `The work offered to your firm has been reassigned because no reply was received within the acceptance window. No action is needed. Please keep your rate card and capacity up to date at ${link("/rates")}.${sign}`,
      };
    case "milestone_ready_for_review":
      return {
        inApp: true,
        subject: "A step is ready for your approval",
        body: `MKW Advisors has checked a step of your engagement and it is ready for your approval: ${link(`/engagement/${vars.engagementId ?? ""}`)}.\n\nIf you take no action within 5 working days, the step is approved under your client terms.${sign}`,
      };
    case "milestone_qa_rejected":
      return {
        inApp: true,
        subject: "A step was sent back for rework",
        body: `MKW Advisors has reviewed the evidence for a step and sent it back. Open the engagement at ${link(`/engagement/${vars.engagementId ?? ""}`)} to read the note and upload the corrected evidence.${sign}`,
      };
    case "change_order_to_approve":
      return {
        inApp: true,
        subject: "A change to your scope needs your approval",
        body: `Your partner firm has proposed a change to the scope of your engagement and MKW Advisors has priced it. Please approve or decline it at ${link(`/engagement/${vars.engagementId ?? ""}`)}. No extra work starts until you approve.${sign}`,
      };
    case "payout_released":
      return {
        inApp: true,
        subject: `Payout of ${aed(vars.amountFils)} released`,
        body: `MKW Advisors has released a payout of ${aed(vars.amountFils)} to your firm. It reaches your account within 7 working days. Details are at ${link("/payouts")}.${sign}`,
      };
    case "user_invited":
      return {
        inApp: false,
        subject: `You have been added to ${brand.name}`,
        body: `An account has been created for you at ${vars.orgName} as ${roleWords(vars.role)}. Sign in with your work email at ${link("/")}; we email you a six-digit code each time, no password needed.${sign}`,
      };
    case "invoice_issued":
      return {
        inApp: true,
        subject: vars.creditNote ? `Credit note ${vars.number} for ${aed(vars.amountFils)}` : `Tax invoice ${vars.number} for ${aed(vars.amountFils)}`,
        body: vars.creditNote
          ? `We have refunded ${aed(vars.amountFils)} and issued credit note ${vars.number}. Download it from your engagement: ${link(`/engagement/${vars.engagementId}`)}.${sign}`
          : `Thank you for your payment of ${aed(vars.amountFils)}. Tax invoice ${vars.number} is ready to download from your engagement: ${link(`/engagement/${vars.engagementId}`)}.${sign}`,
      };
    case "payout_remittance":
      return {
        inApp: true,
        subject: `Remittance advice: ${aed(vars.amountFils)} paid to your firm`,
        body: `MKW Advisors has paid ${aed(vars.amountFils)} to your firm's account in payout run ${vars.runReference} (bank reference ${vars.bankReference}). It covers ${vars.count} payout(s); details are at ${link("/payouts")}.${sign}`,
      };
    case "intake_received":
      return {
        inApp: true,
        subject: "We have your request",
        body: `Thank you. We have received your request for ${vars.company} and are preparing your offers; where a rule is not certain for your case, a person checks it first.${vars.newAccount ? `\n\nAn account has been created for you. Sign in with this email address at ${link("/")}: we send a six-digit code each time, no password needed.` : `\n\nFollow progress at ${link("/")}.`}${sign}`,
      };
    case "intake_signin":
      return {
        inApp: false,
        subject: "Continue with your request",
        body: `Thank you for getting in touch. To continue, sign in with this email address at ${link("/")}: we send a six-digit code each time, no password needed. If you did not fill in our form, you can ignore this message.${sign}`,
      };
    case "partner_status_changed":
      return {
        inApp: true,
        subject: `Your firm is now ${String(vars.status).replace("_", " ")} with ${brand.name}`,
        body: `${vars.firm} has moved to "${String(vars.status).replace("_", " ")}" in the ${brand.signOff}.${vars.note ? `\n\nNote from MKW Advisors: ${vars.note}` : ""}${vars.status === "pilot" ? "\n\nDuring the pilot you can take up to three jobs at a time until five have been delivered on time." : ""}${vars.status === "signed" ? "\n\nYou can now receive work across your covered emirates and services." : ""}${vars.status === "paused" ? "\n\nNo new work is offered while paused; work already accepted continues." : ""}\n\nSee your profile at ${link("/partner")}.${sign}`,
      };
    case "partner_document_reviewed":
      return {
        inApp: true,
        subject: `${roleWords(vars.kind)}: ${vars.status}`,
        body: `MKW Advisors has reviewed the ${roleWords(vars.kind)} you uploaded: ${vars.status}.${vars.note ? `\n\n${vars.note}` : ""}\n\nDocuments: ${link("/partner/onboarding")}.${sign}`,
      };
    case "licence_expiring":
      return {
        inApp: true,
        subject: `Trade licence expires on ${vars.expiresOn}: ${vars.firm}`,
        body: `The trade licence on file for ${vars.firm} expires on ${vars.expiresOn}. Upload the renewed licence before then; on expiry the firm is paused automatically and receives no new work until the new licence is verified.\n\n${link("/partner/onboarding")}${sign}`,
      };
    case "licence_expired":
      return {
        inApp: true,
        subject: `Trade licence expired: ${vars.firm} paused`,
        body: `The trade licence on file for ${vars.firm} expired on ${vars.expiresOn}. The firm is paused: work already accepted continues, no new work is offered. Upload the renewed licence at ${link("/partner/onboarding")}; MKW Advisors verifies it and lifts the pause.${sign}`,
      };
    case "documents_requested":
      return {
        inApp: true,
        subject: `Documents needed for your engagement ${ref(vars.engagementId)}`,
        body: `To start "${vars.step}" we need ${vars.count} document(s) from you: ${vars.kinds}. Upload them at ${link(`/engagement/${vars.engagementId}`)}. Your files are stored in the UAE and shared only with the firm doing this work.${sign}`,
      };
    case "documents_complete":
      return {
        inApp: true,
        subject: `Client documents complete for ${ref(vars.engagementId)}`,
        body: `All documents requested for "${vars.step}" have been uploaded by the client. Review them at ${link(`/engagement/${vars.engagementId}`)} and mark each received or ask again.${sign}`,
      };
    case "step_delayed_client":
      return {
        inApp: true,
        subject: `Update on your engagement ${ref(vars.engagementId)}: "${vars.step}" is running late`,
        body: `"${vars.step}" was due on ${vars.dueDate} and is not yet complete. The new expected date is ${vars.expectedDate}. We are on it; if a step runs more than five working days late, our service guarantee applies: a credit of part of the fee is calculated by rule and confirmed by our team.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}`,
      };
    case "step_delayed_partner":
      return {
        inApp: true,
        subject: `Overdue: "${vars.step}" on ${ref(vars.engagementId)}`,
        body: `"${vars.step}" was due on ${vars.dueDate}. The client has been told to expect it by ${vars.expectedDate}. Submit the evidence or message MKW Advisors with the reason today; delays attributed to the partner reduce the completion payout under the service guarantee.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}`,
      };
    case "guarantee_credit":
      return {
        inApp: true,
        subject: `Service guarantee credit of AED ${vars.amountAed} on ${ref(vars.engagementId)}`,
        body: `"${vars.step}" ran more than five working days late, so under our service guarantee AED ${vars.amountAed} is credited to you${vars.how === "applied" ? " and deducted from your balance payment" : "; our finance team will arrange the refund"}.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}`,
      };
    case "rating_received":
      return {
        inApp: true,
        subject: `Client rating on ${ref(vars.engagementId)}: ${vars.stars}/5`,
        body: `The client rated the completed work ${vars.stars} out of 5. Ratings feed your scorecard, which MKW Advisors recomputes weekly.\n\n${link(`/engagement/${vars.engagementId}`)}${sign}`,
      };
    case "obligation_reminder":
      return {
        inApp: true,
        subject: vars.when === "overdue" ? `Overdue: ${vars.title} was due ${vars.dueDate}` : `Reminder: ${vars.title} due ${vars.dueDate} (${vars.when})`,
        body: `${vars.title} is due on ${vars.dueDate}${vars.when === "overdue" ? " and we have no filing confirmation from you yet" : ""}.${vars.uncertain ? " This date is our estimate (UNCERTAIN); check it with MKW Advisors before relying on it." : ""}\n\nWhen it is filed, upload the confirmation at ${link("/compliance")} and we record it as met. We do not file on your behalf; ask us if you want this handled as a service.${sign}`,
      };
    case "ops_digest":
      return {
        inApp: true,
        subject: `Ops digest: ${vars.total ?? 0} item(s) need a person today`,
        body:
          `Good morning. ${vars.total ?? 0} item(s) wait for a person: ${vars.overdue ?? 0} past their target, ${vars.sinceLast ?? 0} new since the last digest.\n\n` +
          `  Offers needing a price decision: ${vars.offer_review ?? 0}\n` +
          `  Offers ready to publish: ${vars.offer_ready ?? 0}\n` +
          `  Requests needing a quote: ${vars.needs_quote ?? 0}\n` +
          `  Evidence to check: ${vars.qa ?? 0}\n` +
          `  Client issues raised: ${vars.dispute ?? 0}\n` +
          `  Lines with no partner: ${vars.unallocated ?? 0}\n` +
          `  Payouts ready to release: ${vars.payout ?? 0}\n` +
          `  Everything else: ${Number(vars.total ?? 0) - ["offer_review", "offer_ready", "needs_quote", "qa", "dispute", "unallocated", "payout"].reduce((n, k) => n + Number(vars[k] ?? 0), 0)}\n\n` +
          `Open the queue at ${link("/home")}.${sign}`,
      };
    // About the platform itself, to MKW's alert address (O13). Never names a client or a partner.
    case "ops_alert": {
      const state = vars.state === "resolved" ? "Resolved" : vars.state === "reminder" ? "Still open" : "Alert";
      return {
        inApp: false,
        subject: `${state}: ${vars.summary ?? ""}`,
        body:
          `${state} (${vars.severity ?? "warning"}): ${vars.summary ?? ""}\n\nOpened ${when(vars.openedAt)}.` +
          (vars.state === "resolved" ? ` Cleared ${when(vars.closedAt)}; nothing more to do.` : ` It closes on its own when the cause clears. The runbook is in docs/DEPLOY.md (Alerts).`) +
          `\n\nSee the System page at ${link("/system")}.${sign}`,
      };
    }
  }
}
