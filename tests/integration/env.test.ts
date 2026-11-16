import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "./helpers/harness"; // sets the dummy TEST_ENV values on import
import {
  env,
  resetEnvCacheForTests,
  squareEnv,
  squareEnvironmentOrNull,
  webhookEnv,
} from "@/lib/server/env";
import { AppError } from "@/lib/server/errors";

// Each test mutates process.env; snapshot and restore so other files are unaffected.
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  resetEnvCacheForTests();
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCacheForTests();
});

const CIPHER = "encrypted:BPzyUro6haNTiIr+rOZUFwyh+C96Fq";

describe("env tiers", () => {
  it("core env does not need any Square settings (launch fallback)", () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("SQUARE_")) delete process.env[k];
    expect(() => env()).not.toThrow();
    expect(squareEnvironmentOrNull()).toBeNull();
    expect(webhookEnv()).toBeNull();
  });

  it("names a value that is still dotenvx ciphertext instead of failing obscurely", () => {
    process.env.DATABASE_URL = CIPHER;
    expect(() => env()).toThrow(/DATABASE_URL: still dotenvx-encrypted/);
  });

  it("never echoes a secret value in the error", () => {
    process.env.SESSION_SECRET = "too-short-secret-value";
    let message = "";
    try {
      env();
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("SESSION_SECRET");
    expect(message).not.toContain("too-short-secret-value");
  });

  it("rejects a non-postgres DATABASE_URL (ciphertext used to pass zod's .url())", () => {
    process.env.DATABASE_URL = "https://example.com";
    expect(() => env()).toThrow(/DATABASE_URL: must be a postgres:\/\/ connection string/);
  });

  it("squareEnv: missing token → 503 square_not_configured with a staff-readable message", () => {
    process.env.SQUARE_ACCESS_TOKEN = "";
    try {
      squareEnv();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).status).toBe(503);
      expect((e as AppError).code).toBe("square_not_configured");
      expect((e as AppError).message).toMatch(/Mark paid/);
    }
  });

  it("squareEnv: encrypted location id is reported as not configured", () => {
    process.env.SQUARE_LOCATION_ID = CIPHER;
    expect(() => squareEnv()).toThrow(AppError);
  });

  it("webhookEnv: empty signature key, encrypted key, or non-https URL → null", () => {
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "";
    expect(webhookEnv()).toBeNull();
    resetEnvCacheForTests();
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = CIPHER;
    expect(webhookEnv()).toBeNull();
    resetEnvCacheForTests();
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "real-key";
    process.env.SQUARE_WEBHOOK_URL = "http://8balllounge.com.au/api/square/webhook";
    expect(webhookEnv()).toBeNull();
  });

  it("webhook route answers 503 (so Square retries) when verification isn't configured", async () => {
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = "";
    const { POST } = await import("@/app/api/square/webhook/route");
    const res = await POST(
      new Request("https://8balllounge.com.au/api/square/webhook", {
        method: "POST",
        headers: { "x-square-hmacsha256-signature": "anything" },
        body: JSON.stringify({ event_id: "e1", type: "terminal.checkout.updated" }),
      }),
    );
    expect(res.status).toBe(503);
  });
});
