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
  | "ops_digest";

export type Vars = Record<string, string | number | undefined>;

export interface Rendered {
  subject: string;
  body: string;
  /** Shown in the recipient's in-app bell. Sign-in codes are email-only. */
  inApp: boolean;
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
        subject: `Deposit of ${aed(vars.amountFils)} to start your engagement`,
        body: `Thank you for accepting your offer. To start the work, please pay the deposit of ${aed(vars.amountFils)}: half of the professional fees plus all government fees, which we pass on at cost.\n\nPay by bank transfer to MKW Advisors quoting reference ${ref(vars.engagementId)}, or use the payment link in your engagement: ${link(`/engagement/${vars.engagementId}`)}.${sign}`,
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
    case "ops_digest":
      return {
        inApp: true,
        subject: `Ops digest: ${vars.total ?? 0} item(s) need a person today`,
        body:
          `Good morning. The exception queue this morning:\n\n` +
          `  Offers needing a price decision: ${vars.offer_review ?? 0}\n` +
          `  Offers ready to publish: ${vars.offer_ready ?? 0}\n` +
          `  Requests needing a quote: ${vars.needs_quote ?? 0}\n` +
          `  Evidence to check: ${vars.qa ?? 0}\n` +
          `  Client issues raised: ${vars.dispute ?? 0}\n` +
          `  Lines with no partner: ${vars.unallocated ?? 0}\n` +
          `  Payouts ready to release: ${vars.payout ?? 0}\n\n` +
          `Open the queue at ${link("/home")}.${sign}`,
      };
  }
}
