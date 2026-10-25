/** Helpers the route modules and the server share. */
import type { FastifyRequest } from "fastify";

export const COOKIE = "tasees_session";

export const publicUser = (u: NonNullable<FastifyRequest["user"]>) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  orgId: u.orgId,
  orgName: u.orgName,
  orgType: u.orgType,
});

export function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

export function cookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}
