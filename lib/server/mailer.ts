import "server-only";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { MailEnv } from "./env";

/*
 * Amazon SES. Credentials are passed to the client explicitly, so any AWS_* variables the host
 * sets for its own use (which may belong to a different AWS account or role) never stand in for
 * the SES keys.
 */

export interface Email {
  from: string;
  to: string;
  /** Where Reply goes in the mail client. */
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
}

/** Sends one email or throws. Swapped out in tests. */
export type Mailer = (cfg: MailEnv, email: Email) => Promise<void>;

/** Long enough for SES on a bad day; short enough not to hold the function open for minutes. */
const SEND_TIMEOUT_MS = 10_000;

let client: { key: string; ses: SESClient } | null = null;

function ses(cfg: MailEnv): SESClient {
  const key = `${cfg.SES_AWS_REGION}:${cfg.SES_AWS_ACCESS_KEY_ID}`;
  if (client?.key !== key) {
    client = {
      key,
      ses: new SESClient({
        region: cfg.SES_AWS_REGION,
        credentials: { accessKeyId: cfg.SES_AWS_ACCESS_KEY_ID, secretAccessKey: cfg.SES_AWS_SECRET_ACCESS_KEY },
        maxAttempts: 2,
      }),
    };
  }
  return client.ses;
}

const sesMailer: Mailer = async (cfg, m) => {
  const command = new SendEmailCommand({
    Source: m.from,
    Destination: { ToAddresses: [m.to] },
    ReplyToAddresses: m.replyTo ? [m.replyTo] : undefined,
    Message: {
      Subject: { Data: m.subject, Charset: "UTF-8" },
      Body: {
        Text: { Data: m.text, Charset: "UTF-8" },
        Html: { Data: m.html, Charset: "UTF-8" },
      },
    },
  });
  await ses(cfg).send(command, { abortSignal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
};

let override: Mailer | null = null;

export function sendMail(cfg: MailEnv, email: Email): Promise<void> {
  return (override ?? sesMailer)(cfg, email);
}

/** Tests: capture or fail sends instead of calling SES. null puts SES back. */
export function setMailerForTests(m: Mailer | null): void {
  override = m;
}

/** HTML-escape a value before it goes into an email body. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
