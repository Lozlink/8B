import "server-only";
import { z } from "zod";

const ENCRYPTED = /^encrypted:/;

/**
 * Server environment, validated lazily on first use so `next build` doesn't need secrets.
 * Locally these come from dotenvx (`pnpm dev` wraps `dotenvx run`). On Vercel set them as
 * Project → Environment Variables (or ship the dotenvx-encrypted .env.production together with a
 * loader that decrypts it — see README).
 */
const schema = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// connection string"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  DEVICE_ENROL_CODE: z.string().min(12, "DEVICE_ENROL_CODE must be at least 12 characters"),

  SQUARE_ENVIRONMENT: z.enum(["sandbox", "production"]),
  SQUARE_ACCESS_TOKEN: z.string().min(1),
  SQUARE_LOCATION_ID: z.string().min(1),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1),
  /** Must match the webhook subscription URL in the Square Developer Console exactly. */
  SQUARE_WEBHOOK_URL: z.string().regex(/^https:\/\//, "must be an https:// URL"),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  // A value still in dotenvx ciphertext means nothing decrypted .env.production for this process
  // (e.g. the private key isn't set where the app runs). Say so plainly instead of failing later
  // with a confusing DNS or validation error.
  const stillEncrypted = Object.keys(schema.shape).filter((k) => ENCRYPTED.test(process.env[k] ?? ""));
  if (stillEncrypted.length > 0) {
    throw new Error(
      `Server env is still dotenvx-encrypted (${stillEncrypted.join(", ")}). ` +
        "Provide the decryption key (DOTENV_PRIVATE_KEY_PRODUCTION) or set plain values in the host's env.",
    );
  }
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment — ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
