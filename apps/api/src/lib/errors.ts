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
