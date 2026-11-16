import "server-only";
import { z } from "zod";
import { AppError } from "./errors";

/*
 * Server environment, validated lazily on first use so `next build` doesn't need secrets.
 *
 * Three tiers:
 *   env()        — what the app needs to run at all (database, cookie signing, device enrolment).
 *   squareEnv()  — Square Terminal API; only checked when a Square feature is used, so the venue
 *                  can run on the brief's fallback (ring up in Square POS + "Mark paid") without it.
 *   webhookEnv() — Square webhook signature verification; only checked by the webhook route.
 *
 * Values come from .env files loaded by Next (production: the dotenvx-encrypted .env.production,
 * decrypted by @dotenvx/next-env using DOTENV_PRIVATE_KEY_PRODUCTION) or from the host's env vars.
 */

const ENCRYPTED = /^encrypted:/;

const coreSchema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  SESSION_SECRET: z.string().min(32, "must be at least 32 characters"),
  DEVICE_ENROL_CODE: z.string().min(12, "must be at least 12 characters"),
});

const squareSchema = z.object({
  SQUARE_ENVIRONMENT: z.enum(["sandbox", "production"]),
  SQUARE_ACCESS_TOKEN: z.string().min(1, "is empty"),
  SQUARE_LOCATION_ID: z.string().min(1, "is empty"),
});

const webhookSchema = z.object({
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1, "is empty"),
  /** Must match the webhook subscription URL in the Square Developer Console exactly. */
  SQUARE_WEBHOOK_URL: z.string().regex(/^https:\/\//, "must be an https:// URL"),
});

export type ServerEnv = z.infer<typeof coreSchema>;
export type SquareEnv = z.infer<typeof squareSchema>;
export type WebhookEnv = z.infer<typeof webhookSchema>;

/** Validates one tier against process.env. `problems` lists "KEY: reason" (never values). */
function check<T extends z.ZodRawShape>(
  schema: z.ZodObject<T>,
): { data: z.infer<z.ZodObject<T>> | null; problems: string[] } {
  // A value still in dotenvx ciphertext means nothing decrypted it for this process. Say so plainly
  // instead of failing later with a confusing DNS, signature or validation error.
  const encrypted = Object.keys(schema.shape).filter((k) => ENCRYPTED.test(process.env[k] ?? ""));
  if (encrypted.length > 0) {
    return {
      data: null,
      problems: encrypted.map((k) => `${k}: still dotenvx-encrypted (is DOTENV_PRIVATE_KEY_PRODUCTION set?)`),
    };
  }
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return { data: parsed.data, problems: [] };
  return { data: null, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
}

let core: ServerEnv | null = null;
let square: SquareEnv | null = null;
let webhook: WebhookEnv | null = null;

export function env(): ServerEnv {
  if (core) return core;
  const r = check(coreSchema);
  if (!r.data) throw new Error(`Invalid server environment — ${r.problems.join("; ")}`);
  core = r.data;
  return core;
}

/** Throws a staff-readable 503 when the Terminal API isn't configured. */
export function squareEnv(): SquareEnv {
  if (square) return square;
  const r = check(squareSchema);
  if (!r.data) {
    console.error("[env] Square not configured:", r.problems.join("; "));
    throw new AppError(
      503,
      "square_not_configured",
      "Square isn't set up for this app yet. Take the payment in Square POS and use Mark paid.",
    );
  }
  square = r.data;
  return square;
}

/** Non-throwing peek for display (the admin Terminal tab). */
export function squareEnvironmentOrNull(): SquareEnv["SQUARE_ENVIRONMENT"] | null {
  const v = process.env.SQUARE_ENVIRONMENT;
  return v === "sandbox" || v === "production" ? v : null;
}

/** null when webhook verification isn't configured (the route then refuses every event). */
export function webhookEnv(): WebhookEnv | null {
  if (webhook) return webhook;
  const r = check(webhookSchema);
  if (!r.data) {
    console.error("[env] Square webhook not configured:", r.problems.join("; "));
    return null;
  }
  webhook = r.data;
  return webhook;
}

/** Tests only: forget validated values so a test can change process.env. */
export function resetEnvCacheForTests(): void {
  core = null;
  square = null;
  webhook = null;
}
