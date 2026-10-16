/**
 * Outbound messages. Development logs them; production plugs in email (Google Workspace or SendGrid)
 * and WhatsApp (WATI templates). Every send is a template with variables, never free text from users.
 */
export interface Notification {
  to: string;
  channel: "email" | "whatsapp";
  template:
    | "login_code"
    | "offer_ready"
    | "payment_due"
    | "allocation_offered"
    | "allocation_reassigned"
    | "milestone_ready_for_review"
    | "milestone_qa_rejected"
    | "change_order_to_approve"
    | "payout_released"
    | "user_invited";
  vars: Record<string, string | number>;
}

export interface Notifier {
  send(n: Notification): Promise<void>;
  sent: Notification[];
}

export function consoleNotifier(log: (msg: string) => void = console.log): Notifier {
  const sent: Notification[] = [];
  return {
    sent,
    async send(n) {
      sent.push(n);
      if (sent.length > 500) sent.shift();
      log(`[notify] ${n.channel} ${n.template} -> ${n.to} ${JSON.stringify(n.vars)}`);
    },
  };
}
