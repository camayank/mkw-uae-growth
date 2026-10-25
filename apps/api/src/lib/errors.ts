export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code = "error",
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new HttpError(400, msg, "bad_request");
export const unauthorised = (msg = "Sign in to continue") => new HttpError(401, msg, "unauthorised");
export const forbidden = (msg = "Your role cannot do this") => new HttpError(403, msg, "forbidden");
export const notFound = (what = "Not found") => new HttpError(404, what, "not_found");
export const conflict = (msg: string) => new HttpError(409, msg, "conflict");

/**
 * Error text for logs, job records and alerts (O13): an error can quote the data that caused it (Postgres puts the
 * offending value in "Key (email)=(…)", a provider may echo an address). Values in a Postgres key detail and anything
 * shaped like an email address are replaced, and the text is cut to `max` characters.
 */
export function cleanErrorText(text: string, max = 300): string {
  return text
    .replace(/\)=\([^)]*\)/g, ")=([value])")
    .replace(/[^\s@()<>"']+@[^\s@()<>"']+/g, "[address]")
    .slice(0, max);
}

/** The pino serializer for errors: type, code, cleaned message and stack; never `detail`, `where` or other fields. */
export function errorForLog(e: unknown): { type: string; message: string; stack: string; code?: string } {
  const err = e as { name?: string; code?: string; message?: string; stack?: string };
  return { type: err?.name ?? "Error", code: err?.code, message: cleanErrorText(String(err?.message ?? e), 500), stack: cleanErrorText(err?.stack ?? "", 2000) };
}
