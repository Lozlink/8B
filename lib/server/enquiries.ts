import "server-only";
import { createHmac } from "node:crypto";
import { z } from "zod";
import type { EnquiryDTO } from "@/lib/domain/types";
import { formatCalendarDate } from "@/lib/format";
import { localDate } from "@/lib/pricing";
import { site } from "@/lib/site/content";
import { ENQUIRY_LIMITS as L, type EnquiryKind } from "@/lib/site/enquiry";
import { APP_ORIGIN } from "@/lib/site/routing";
import { audit } from "./audit";
import type { Actor, Manager } from "./auth";
import { db, withTx, type Db } from "./db";
import { env, mailEnv } from "./env";
import { esc, sendMail, type Email } from "./mailer";
import { badRequest, conflict, notFound, tooMany } from "./errors";
import { getSettings } from "./repo";

/*
 * Enquiries from the public site's forms: the functions page and the contact page. Anyone on the
 * internet can post one, so:
 *   - what arrives is cleaned and checked here, whatever the form already checked;
 *   - a hidden field catches simple bots, which are told it worked and nothing is kept;
 *   - each sender (by a keyed hash of their IP, never the IP itself) gets a few an hour, and
 *     there's a daily ceiling across everyone so a flood can't fill the table.
 * Staff see them under Admin → Enquiries, where a manager marks each one as dealt with. When SES
 * is set up (lib/server/env.ts → mailEnv), each one is also emailed to the venue once it's saved.
 */

/** Per sender. */
const SOURCE_LIMITS = [
  { minutes: 60, max: 3 },
  { minutes: 24 * 60, max: 8 },
] as const;
/** Across everyone, per rolling day. Far above anything real for a seven-table room. */
const DAILY_CEILING = 100;
/** How far ahead a date can be: two years catches a mistyped year without turning anyone away. */
const MAX_DAYS_AHEAD = 731;

const callUs = site.phone ? ` or call us on ${site.phone}` : "";

/** Loose shape first: the caps only stop absurd payloads. The checks people can hit are below. */
const rawShape = z.object({
  kind: z.enum(["functions", "contact"]),
  name: z.string().max(2000),
  company: z.string().max(2000).nullish(),
  email: z.string().max(2000),
  phone: z.string().max(500).nullish(),
  preferredDate: z.string().max(40).nullish(),
  groupSize: z.number().int().nullish(),
  message: z.string().max(20000).nullish(),
  website: z.string().max(2000).nullish(),
});

export interface CleanEnquiry {
  kind: EnquiryKind;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  /** "YYYY-MM-DD" */
  preferredDate: string | null;
  groupSize: number | null;
  message: string | null;
}

/** One line: control characters and runs of whitespace become one space, ends trimmed. */
const oneLine = (s: string | null | undefined) => (s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/** A message keeps its line breaks (no more than one blank line in a row); other control characters go. */
function multiLine(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Stricter than the RFC on purpose: no real address needs these characters, and keeping them out
// means the address can go straight into a mailto: link in the staff app without adding a cc or body.
const EMAIL = /^[^\s@?&#<>"',;:()[\]\\]+@[^\s@?&#<>"',;:()[\]\\]+\.[^\s@?&#<>"',;:()[\]\\]+$/;
const PHONE = /^\+?[0-9 ()-]+$/;
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-12-12" + 3 → "2026-12-15", by the calendar (no time zone involved). */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Today on the venue's calendar, as "YYYY-MM-DD". */
export function venueToday(timeZone: string, now = new Date()): string {
  const { y, m, d } = localDate(timeZone, now.getTime());
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Checks and tidies a posted enquiry. Too long is refused rather than cut, so what staff read is
 * what was sent. `today` is the venue's date ("YYYY-MM-DD"). Throws a 400 with a message the
 * form shows as it is. The contact form has no company, date or numbers: anything sent in those
 * from it is dropped. It does need a message.
 */
export function cleanEnquiry(input: z.infer<typeof rawShape>, today: string): CleanEnquiry {
  const { kind } = input;
  const functions = kind === "functions";
  const name = oneLine(input.name);
  if (!name) throw badRequest("Add your name.");
  if (name.length > L.name) throw badRequest(`Your name can be ${L.name} characters at most.`);

  const company = (functions && oneLine(input.company)) || null;
  if (company && company.length > L.company) throw badRequest(`The company name can be ${L.company} characters at most.`);

  const email = oneLine(input.email);
  if (!email) throw badRequest("Add an email so we can get back to you.");
  if (email.length > L.email || !EMAIL.test(email)) throw badRequest("That email doesn't look right.");

  const phone = oneLine(input.phone) || null;
  if (phone) {
    const digits = phone.replace(/\D/g, "").length;
    if (phone.length > L.phone || !PHONE.test(phone) || digits < 6) throw badRequest("That phone number doesn't look right.");
  }

  const dateRaw = functions ? oneLine(input.preferredDate) : "";
  let preferredDate: string | null = null;
  if (dateRaw) {
    const m = YMD.exec(dateRaw);
    const real = m && addDays(dateRaw, 0) === dateRaw; // 2026-02-30 comes back as 2026-03-02
    if (!real) throw badRequest("That date doesn't look right.");
    if (dateRaw < today) throw badRequest("That date has already gone. Pick one from today on.");
    if (dateRaw > addDays(today, MAX_DAYS_AHEAD)) throw badRequest("Pick a date in the next two years.");
    preferredDate = dateRaw;
  }

  const groupSize = functions ? (input.groupSize ?? null) : null;
  if (groupSize !== null && (groupSize < 1 || groupSize > L.groupSizeMax)) {
    throw badRequest(`How many should be between 1 and ${L.groupSizeMax}.`);
  }

  const message = multiLine(input.message) || null;
  if (!message && !functions) throw badRequest("Add a message.");
  if (message && message.length > L.message) throw badRequest(`Keep the message under ${L.message} characters.`);

  return { kind, name, company, email, phone, preferredDate, groupSize, message };
}

/** A keyed hash of the sender's address: enough to count their sends, useless for finding them. */
function sourceHash(ip: string | null): string {
  return createHmac("sha256", env().SESSION_SECRET)
    .update(`enquiry:${ip ?? "unknown"}`)
    .digest("hex");
}

export interface StoredEnquiry extends CleanEnquiry {
  id: string;
}

/**
 * Stores an enquiry from the public form. `stored: false` means the hidden field was filled in:
 * the sender is told it went through all the same, so a bot learns nothing. Emailing it is a
 * separate step (notifyEnquiry), so a slow or broken mail service never loses an enquiry.
 */
export async function createEnquiry(
  body: unknown,
  ip: string | null,
  now = new Date(),
): Promise<{ stored: false } | { stored: true; enquiry: StoredEnquiry }> {
  // Only something other than the form gets this wrong, so no field-by-field detail.
  const parsed = rawShape.safeParse(body);
  if (!parsed.success) throw badRequest("That didn't go through. Reload the page and try again.");
  const input = parsed.data;
  if (oneLine(input.website)) return { stored: false };

  const { timezone } = await getSettings(db());
  const e = cleanEnquiry(input, venueToday(timezone, now));
  const source = sourceHash(ip);

  const outcome = await withTx(async (tx) => {
    // Two sends from the same place at once are counted one after the other, not both as the first.
    await tx`select pg_advisory_xact_lock(hashtext(${"enquiry:" + source}))`;
    const [n] = await tx<{ hour: number; day: number; everyone: number }[]>`
      select
        count(*) filter (where source_hash = ${source} and created_at > now() - make_interval(mins => ${SOURCE_LIMITS[0].minutes}))::int as hour,
        count(*) filter (where source_hash = ${source})::int as day,
        count(*)::int as everyone
      from public.enquiries
      where created_at > now() - make_interval(mins => ${SOURCE_LIMITS[1].minutes})`;
    if ((n?.hour ?? 0) >= SOURCE_LIMITS[0].max || (n?.day ?? 0) >= SOURCE_LIMITS[1].max) return "slow_down" as const;
    if ((n?.everyone ?? 0) >= DAILY_CEILING) return "full" as const;
    const [row] = await tx<{ id: string }[]>`
      insert into public.enquiries (kind, name, company, email, phone, preferred_date, group_size, message, source_hash)
      values (${e.kind}, ${e.name}, ${e.company}, ${e.email}, ${e.phone}, ${e.preferredDate}, ${e.groupSize}, ${e.message}, ${source})
      returning id`;
    return row.id;
  });

  if (outcome === "slow_down") throw tooMany(`We've got a few from you already. Give it an hour${callUs}.`);
  if (outcome === "full") throw tooMany(`We can't take any more messages today. Try again tomorrow${callUs}.`);
  return { stored: true, enquiry: { ...e, id: outcome } };
}

/** The email the venue gets for an enquiry: subject, plain text and HTML. */
export function enquiryEmail(e: StoredEnquiry): Pick<Email, "subject" | "text" | "html"> {
  const functions = e.kind === "functions";
  const date = e.preferredDate ? formatCalendarDate(e.preferredDate) : null;
  const people = e.groupSize ? `${e.groupSize} ${e.groupSize === 1 ? "person" : "people"}` : null;

  const who = e.company ? `${e.name} (${e.company})` : e.name;
  const subject = functions
    ? [`Functions enquiry: ${who}`, date, people].filter(Boolean).join(" · ")
    : `Message from ${e.name}`;
  const intro = functions ? "A functions enquiry just came in from the website." : "A message just came in from the website's contact page.";

  const rows: [string, string][] = [
    ["Name", e.name],
    ...(functions ? [["Company", e.company ?? "—"] as [string, string]] : []),
    ["Email", e.email],
    ["Phone", e.phone ?? "—"],
    ...(functions
      ? ([
          ["Date", date ?? "—"],
          ["How many", e.groupSize ? String(e.groupSize) : "—"],
        ] as [string, string][])
      : []),
  ];
  const adminUrl = `${APP_ORIGIN}/admin`;
  const replyLine = `Reply to this email to answer ${e.name} directly.`;
  const adminLine = "Once it's sorted, mark it dealt with in Admin → Enquiries:";

  const text = [
    intro,
    "",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(e.message ? ["", "Message:", e.message] : []),
    "",
    replyLine,
    `${adminLine} ${adminUrl}`,
  ].join("\n");

  const cell = "border:1px solid #ccc;padding:6px 10px;text-align:left;vertical-align:top";
  const html = `
<html>
  <body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#111">
    <p>${esc(intro)}</p>
    <table cellpadding="0" cellspacing="0" style="border-collapse:collapse">
      ${rows.map(([label, value]) => `<tr><th style="${cell}">${esc(label)}</th><td style="${cell}">${esc(value)}</td></tr>`).join("\n      ")}
    </table>
    ${e.message ? `<p><strong>Message</strong></p><p style="white-space:pre-wrap">${esc(e.message).replace(/\n/g, "<br>")}</p>` : ""}
    <p>${esc(replyLine)}</p>
    <p>${esc(adminLine)} <a href="${esc(adminUrl)}">${esc(adminUrl)}</a></p>
  </body>
</html>`.trim();

  return { subject, text, html };
}

/**
 * Emails a saved enquiry to the venue, with Reply going to the sender. Never throws: the enquiry is
 * already in Admin → Enquiries, so a failed email is logged (by id, no contact details) and that's all.
 */
export async function notifyEnquiry(e: StoredEnquiry): Promise<"sent" | "not_configured" | "failed"> {
  const cfg = mailEnv();
  const to = cfg?.ENQUIRY_TO_EMAIL ?? site.email;
  if (!cfg || !to) return "not_configured";
  try {
    await sendMail(cfg, { from: cfg.ENQUIRY_FROM_EMAIL, to, replyTo: e.email, ...enquiryEmail(e) });
    return "sent";
  } catch (err) {
    console.error("[enquiry] email failed; it is still in Admin → Enquiries", { id: e.id }, err);
    return "failed";
  }
}

interface EnquiryRow {
  id: string;
  kind: EnquiryKind;
  created_at: Date;
  name: string;
  company: string | null;
  email: string;
  phone: string | null;
  preferred_date: string | null;
  group_size: number | null;
  message: string | null;
  handled_at: Date | null;
  handled_by_name: string | null;
}

/** Open ones first, newest first within each. */
export async function listEnquiries(q: Db = db(), limit = 200): Promise<EnquiryDTO[]> {
  const rows = await q<EnquiryRow[]>`
    select e.id, e.kind, e.created_at, e.name, e.company, e.email, e.phone, e.preferred_date::text as preferred_date,
           e.group_size, e.message, e.handled_at, s.name as handled_by_name
    from public.enquiries e
    left join public.staff s on s.id = e.handled_by
    order by (e.handled_at is null) desc, e.created_at desc
    limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
    name: r.name,
    company: r.company,
    email: r.email,
    phone: r.phone,
    preferredDate: r.preferred_date,
    groupSize: r.group_size,
    message: r.message,
    handled: r.handled_at ? { at: r.handled_at.toISOString(), byName: r.handled_by_name } : null,
  }));
}

export async function countOpenEnquiries(q: Db = db()): Promise<number> {
  const [r] = await q<{ n: number }[]>`select count(*)::int as n from public.enquiries where handled_at is null`;
  return r?.n ?? 0;
}

/** A manager marks an enquiry as dealt with (`handled`), or puts it back on the open list. */
export async function setEnquiryHandled(actor: Actor, manager: Manager, id: string, handled: boolean): Promise<void> {
  await withTx(async (tx) => {
    const [row] = await tx<{ handled_at: Date | null }[]>`select handled_at from public.enquiries where id = ${id} for update`;
    if (!row) throw notFound("Couldn't find that enquiry.");
    if ((row.handled_at !== null) === handled) {
      throw conflict(handled ? "Someone has already marked that one as dealt with." : "That one is already open.");
    }
    if (handled) {
      await tx`update public.enquiries set handled_at = now(), handled_by = ${manager.id} where id = ${id}`;
    } else {
      await tx`update public.enquiries set handled_at = null, handled_by = null where id = ${id}`;
    }
    // No names or contact details in the audit log: the enquiry's id is enough to find it.
    await audit(tx, {
      actorStaffId: actor.staffId,
      approvedByStaffId: manager.id,
      deviceLabel: actor.deviceLabel,
      action: handled ? "enquiry.handled" : "enquiry.reopened",
      entity: "enquiry",
      entityId: id,
    });
  });
}
