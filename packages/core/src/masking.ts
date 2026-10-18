/**
 * Masks direct contact details in messages between clients and partners,
 * so engagements stay on the platform. Platform staff see the original.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Phone numbers: 7+ digits allowing spaces, dashes, dots, brackets and a leading +.
const PHONE = /(?:\+|00)?\d[\d\s().-]{6,}\d/g;
// Dates such as 20-10-2026, 2026-10-20 or 20/10/26 are not phone numbers.
const DATE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{2,4}$/;
const LINKS =/\b(?:wa\.me|t\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\/\S+/gi;

export interface MaskResult {
  text: string;
  masked: boolean;
}

export function maskContacts(text: string): MaskResult {
  let masked = false;
  const replace = (pattern: RegExp, label: string) => (input: string) =>
    input.replace(pattern, (m) => {
      if (label === "[phone hidden]" && (m.replace(/\D/g, "").length < 7 || DATE.test(m.trim()))) return m;
      masked = true;
      return label;
    });
  const out = [replace(LINKS, "[link hidden]"), replace(EMAIL, "[email hidden]"), replace(PHONE, "[phone hidden]")].reduce(
    (acc, fn) => fn(acc),
    text,
  );
  return { text: out, masked };
}
