import { ROLE_ORG, type Role } from "./types.ts";

/**
 * Field visibility classes. Every money field carries one; the API serialises by role,
 * and the database enforces the same split with column grants (defence in depth).
 *
 *  public      everyone on the engagement
 *  client      client price lines and invoices
 *  partner     the partner's own cost and payouts
 *  internal    platform staff (ops, finance, founder)
 *  finance     margin: finance and founder only
 */
export type Visibility = "public" | "client" | "partner" | "internal" | "finance";

const CAN_SEE: Record<Role, Visibility[]> = {
  client_owner: ["public", "client"],
  client_member: ["public", "client"],
  partner_admin: ["public", "partner"],
  partner_staff: ["public"],
  ops: ["public", "client", "partner", "internal"],
  finance: ["public", "client", "partner", "internal", "finance"],
  founder: ["public", "client", "partner", "internal", "finance"],
  agent: ["public", "internal"],
};

export type FieldMap = Record<string, Visibility>;

/** Field maps for every entity the API returns. Fields not listed are dropped (deny by default). */
export const FIELDS = {
  offer: {
    id: "public",
    requestId: "public",
    tier: "public",
    status: "public",
    validTo: "public",
    professional: "client",
    mkwFees: "client",
    vat: "client",
    government: "public",
    clientTotal: "client",
    partnerPayout: "internal",
    margin: "finance",
    marginBp: "finance",
    linesNeedingReview: "internal",
    lines: "public",
  },
  offerLine: {
    code: "public",
    name: "public",
    qty: "public",
    model: "public",
    govUnitFee: "public",
    clientUnitPrice: "client",
    mkwFeeUnit: "client",
    partnerUnitCost: "internal",
    marginUnit: "finance",
    capUnit: "internal",
    status: "internal",
    reason: "internal",
    partnerId: "internal",
    costSourceId: "internal",
  },
  engagementLine: {
    code: "public",
    name: "public",
    qty: "public",
    govUnitFee: "public",
    clientUnitPrice: "client",
    partnerUnitCost: "partner",
  },
  payout: {
    id: "partner",
    engagementId: "partner",
    stage: "partner",
    amount: "partner",
    status: "partner",
    releasedAt: "partner",
  },
  quoteScore: {
    quoteId: "internal",
    partnerId: "internal",
    comparableCost: "internal",
    score: "internal",
    rank: "internal",
    rankBand: "partner",
  },
  contact: {
    name: "public",
    email: "client",
    phone: "client",
  },
  /** A delay on a step: the client sees that it is late and the new date, never who bears it or the money. */
  delay: {
    id: "public",
    milestoneId: "public",
    engagementId: "public",
    dueDate: "public",
    noticedAt: "public",
    expectedDate: "public",
    cause: "internal",
    causeNote: "internal",
    attributedAt: "internal",
    creditId: "internal",
  },
  /** A service-guarantee credit: the client sees its own credit; the partner sees only a payout reduction. */
  guaranteeCredit: {
    id: "client",
    engagementId: "client",
    milestoneId: "client",
    amount: "client",
    status: "client",
    settledReference: "client",
    base: "internal",
    guaranteeBp: "internal",
    cause: "internal",
    borneByPartner: "internal",
    payoutReduction: "internal",
    decidedBy: "internal",
    waiveReason: "internal",
  },
  /** A client's rating: the partner sees the stars and the masked comment, never who wrote it. */
  rating: {
    engagementId: "public",
    stars: "public",
    comment: "public",
    createdAt: "public",
    authorName: "internal",
    authorUserId: "internal",
    commentOriginal: "internal",
  },
} satisfies Record<string, FieldMap>;

export type EntityKind = keyof typeof FIELDS;

export function canSee(role: Role, v: Visibility): boolean {
  return CAN_SEE[role].includes(v);
}

/**
 * Keep only the fields a role may see. Nested arrays are serialised with `nested`.
 * A partner_staff user never sees money fields; a partner admin sees only its own cost and payouts.
 */
export function serialize<T extends Record<string, unknown>>(
  kind: EntityKind,
  role: Role,
  entity: T,
  nested: Partial<Record<string, EntityKind>> = {},
): Record<string, unknown> {
  const map: FieldMap = FIELDS[kind];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    const vis = map[key];
    if (!vis || !canSee(role, vis)) continue;
    const childKind = nested[key];
    if (childKind && Array.isArray(value)) {
      out[key] = value.map((v) => serialize(childKind, role, v as Record<string, unknown>));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Names of fields that must never reach a role, for leak tests and log redaction. */
export function forbiddenFields(kind: EntityKind, role: Role): string[] {
  const map: FieldMap = FIELDS[kind];
  return Object.entries(map)
    .filter(([, v]) => !canSee(role, v))
    .map(([k]) => k);
}

export const orgTypeOf = (role: Role) => ROLE_ORG[role];
