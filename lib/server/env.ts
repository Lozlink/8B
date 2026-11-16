import "server-only";
import { z } from "zod";

/**
 * Server environment, validated lazily on first use so `next build` doesn't need secrets.
 * Locally these come from dotenvx (`pnpm dev` wraps `dotenvx run`). On Vercel set them as
 * Project → Environment Variables.
 */
const schema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  DEVICE_ENROL_CODE: z.string().min(12, "DEVICE_ENROL_CODE must be at least 12 characters"),

  SQUARE_ENVIRONMENT: z.enum(["sandbox", "production"]),
  SQUARE_ACCESS_TOKEN: z.string().min(1),
  SQUARE_LOCATION_ID: z.string().min(1),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().min(1),
  /** Must match the webhook subscription URL in the Square Developer Console exactly. */
  SQUARE_WEBHOOK_URL: z.string().url(),
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid server environment — ${missing}`);
  }
  cached = parsed.data;
  return cached;
}
