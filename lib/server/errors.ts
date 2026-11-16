/** An error whose message is safe to show staff. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (msg: string, detail?: Record<string, unknown>) => new AppError(400, "bad_request", msg, detail);
export const unauthorized = (msg = "Please log in.") => new AppError(401, "unauthorized", msg);
export const forbidden = (msg = "Not allowed.") => new AppError(403, "forbidden", msg);
export const notFound = (msg = "Not found.") => new AppError(404, "not_found", msg);
export const conflict = (msg: string, detail?: Record<string, unknown>) => new AppError(409, "conflict", msg, detail);
export const tooMany = (msg: string) => new AppError(429, "too_many_attempts", msg);
export const upstream = (msg: string, detail?: Record<string, unknown>) => new AppError(502, "square_error", msg, detail);
