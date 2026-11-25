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
 *   mailEnv()    — Amazon SES, to email the venue when someone sends an enquiry from the public
 *                  site. Optional: without it enquiries still land in Admin → Enquiries.
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

/** Optional: cash through the Square POS app on the drawer iPad (see lib/server/pos-cash.ts). */
const posSchema = z.object({
  /** The Square application id (Developer Console → Credentials). Not a secret, but kept server-side. */
  SQUARE_APPLICATION_ID: z.string().min(1),
  /** Where the iPads reach the app, e.g. https://timer.example.com. Defaults to the webhook URL's origin. */
  APP_ORIGIN: z.string().regex(/^https:\/\/[^/]+$/, "must be https://host with no path").optional(),
});

const webhookSchema = z.object({
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1, "is empty"),
  /** Must match the webhook subscription URL in the Square Developer Console exactly. */
  SQUARE_WEBHOOK_URL: z.string().regex(/^https:\/\//, "must be an https:// URL"),
});

/** Optional: email the venue when an enquiry comes in (lib/server/mailer.ts). */
const mailSchema = z.object({
  SES_AWS_REGION: z.string().min(1, "is empty"),
  SES_AWS_ACCESS_KEY_ID: z.string().min(1, "is empty"),
  SES_AWS_SECRET_ACCESS_KEY: z.string().min(1, "is empty"),
  /** An address on a domain verified in SES, e.g. "8 Ball Lounge <enquiries@8balllounge.com.au>". */
  ENQUIRY_FROM_EMAIL: z.string().min(3, "is empty"),
  /** Who gets the emails. Defaults to the email address on the public site. */
  ENQUIRY_TO_EMAIL: z.string().min(3, "is empty").optional(),
});

export type ServerEnv = z.infer<typeof coreSchema>;
export type MailEnv = z.infer<typeof mailSchema>;
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
let mail: MailEnv | null = null;

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

/**
 * Peek without validating or logging: is there any point asking Square? Background jobs use this so
 * a venue running without Square doesn't log a configuration error on every poll.
 */
export function squareLooksConfigured(): boolean {
  return squareEnvironmentOrNull() !== null && !!process.env.SQUARE_ACCESS_TOKEN && !!process.env.SQUARE_LOCATION_ID;
}

export interface PosCashConfig {
  applicationId: string;
  locationId: string;
  /** Must match the Web Callback URL registered under Point of Sale API in the Developer Console exactly. */
  callbackUrl: string;
}

/**
 * Non-throwing, not cached (three env reads). null = handing cash to Square POS isn't on offer:
 * Square isn't configured, there is no application id, or the app's own address isn't known.
 */
export function posCashConfig(): PosCashConfig | null {
  if (!squareLooksConfigured()) return null;
  const parsed = posSchema.safeParse({
    SQUARE_APPLICATION_ID: process.env.SQUARE_APPLICATION_ID,
    APP_ORIGIN: process.env.APP_ORIGIN || undefined,
  });
  if (!parsed.success) return null;
  let origin = parsed.data.APP_ORIGIN ?? null;
  if (!origin) {
    try {
      const u = new URL(process.env.SQUARE_WEBHOOK_URL ?? "");
      origin = u.protocol === "https:" ? u.origin : null;
    } catch {
      origin = null;
    }
  }
  if (!origin) return null;
  return {
    applicationId: parsed.data.SQUARE_APPLICATION_ID,
    locationId: process.env.SQUARE_LOCATION_ID as string,
    callbackUrl: `${origin}/pos/return`,
  };
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

/**
 * null when SES isn't set up: no email is sent, and nothing is logged if none of its keys are set
 * at all. Some set but not all (or still encrypted) is a mistake worth a line in the log.
 */
export function mailEnv(): MailEnv | null {
  if (mail) return mail;
  const keys = Object.keys(mailSchema.shape);
  if (!keys.some((k) => process.env[k])) return null;
  const r = check(mailSchema);
  if (!r.data) {
    console.error("[env] Enquiry email (SES) not configured:", r.problems.join("; "));
    return null;
  }
  mail = r.data;
  return mail;
}

/** Tests only: forget validated values so a test can change process.env. */
export function resetEnvCacheForTests(): void {
  core = null;
  square = null;
  webhook = null;
  mail = null;
}
