"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { site } from "@/lib/site/content";
import { ENQUIRY_LIMITS as L, type EnquiryInput, type EnquiryKind } from "@/lib/site/enquiry";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

const callUs = site.phone ? `, or call us on ${site.phone}` : "";
const NETWORK_ERROR = `That didn't go through. Try again${callUs}.`;

const inputClass =
  "min-h-14 w-full rounded-xl border-2 border-line bg-bg px-4 text-lg text-chalk transition-colors focus:border-brand";

/** Today on the venue's calendar ("YYYY-MM-DD"), so the date picker starts there. */
function venueToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function Field({ label, optional, wide, children }: { label: string; optional?: boolean; wide?: boolean; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`flex flex-col gap-2 ${wide ? "sm:col-span-2" : ""}`}>
      <label htmlFor={id} className="text-base font-semibold text-chalk">
        {label}
        {optional ? <span className="font-normal text-muted"> (optional)</span> : null}
      </label>
      {children(id)}
    </div>
  );
}

/**
 * The enquiry form on the functions and contact pages. Both land in Admin → Enquiries, labelled by
 * kind. Functions asks for the company, a date and numbers; contact just needs a message.
 */
export function EnquiryForm({ kind }: { kind: EnquiryKind }) {
  const functions = kind === "functions";
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const dateRef = useRef<HTMLInputElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const sending = status.kind === "sending";

  // Set after load, not during render: the page is built ahead of time, so "today" there would be stale.
  // (No date field on the contact form: the ref stays empty.)
  useEffect(() => {
    if (dateRef.current) dateRef.current.min = venueToday();
  }, []);

  useEffect(() => {
    // The form (and the button that had focus) is gone; put focus on what replaced it.
    if (status.kind === "sent") sentRef.current?.focus();
  }, [status.kind]);

  async function onSubmit(ev: React.FormEvent<HTMLFormElement>) {
    ev.preventDefault();
    if (sending) return;
    const f = new FormData(ev.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "");
    const size = s("groupSize").trim();
    const body: EnquiryInput = {
      kind,
      name: s("name"),
      company: functions ? s("company") : null,
      email: s("email"),
      phone: s("phone"),
      preferredDate: functions ? s("preferredDate") : null,
      groupSize: functions && size ? Number(size) : null,
      message: s("message"),
      website: s("website"),
    };

    setStatus({ kind: "sending" });
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15_000);
    try {
      const res = await fetch("/api/enquiries", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        setStatus({ kind: "sent" });
        return;
      }
      const json: unknown = await res.json().catch(() => null);
      const message =
        json && typeof json === "object" && "error" in json && json.error && typeof json.error === "object" && "message" in json.error
          ? String(json.error.message)
          : NETWORK_ERROR;
      setStatus({ kind: "error", message });
    } catch {
      setStatus({ kind: "error", message: NETWORK_ERROR });
    } finally {
      window.clearTimeout(timer);
    }
  }

  if (status.kind === "sent") {
    return (
      <div className="self-start rounded-3xl bg-surface p-8 sm:p-10">
        <h3 ref={sentRef} tabIndex={-1} className="display text-[clamp(2.5rem,7vw,4rem)] text-chalk outline-none">
          {site.form.sentHeading}
        </h3>
        <p className="mt-4 text-xl text-muted">{site.form.sentLead}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="relative rounded-3xl bg-surface p-6 sm:p-10">
      <fieldset disabled={sending} className="grid gap-x-5 gap-y-6 sm:grid-cols-2">
        <legend className="sr-only">{functions ? "Functions enquiry" : "Message"}</legend>
        <Field label="Name" wide={!functions}>
          {(id) => <input id={id} name="name" required maxLength={L.name} autoComplete="name" className={inputClass} />}
        </Field>
        {functions ? (
          <Field label="Company" optional>
            {(id) => <input id={id} name="company" maxLength={L.company} autoComplete="organization" className={inputClass} />}
          </Field>
        ) : null}
        <Field label="Email">
          {(id) => <input id={id} name="email" type="email" required maxLength={L.email} autoComplete="email" className={inputClass} />}
        </Field>
        <Field label="Phone" optional>
          {(id) => <input id={id} name="phone" type="tel" maxLength={L.phone} autoComplete="tel" className={inputClass} />}
        </Field>
        {functions ? (
          <>
            <Field label="Date" optional>
              {(id) => <input id={id} ref={dateRef} name="preferredDate" type="date" className={inputClass} />}
            </Field>
            <Field label="How many" optional>
              {(id) => (
                <input id={id} name="groupSize" type="number" inputMode="numeric" min={1} max={L.groupSizeMax} step={1} className={inputClass} />
              )}
            </Field>
          </>
        ) : null}
        <Field label={functions ? "Anything else" : "Message"} optional={functions} wide>
          {(id) => (
            <textarea
              id={id}
              name="message"
              rows={functions ? 4 : 6}
              required={!functions}
              maxLength={L.message}
              className={`${inputClass} py-3 leading-relaxed`}
            />
          )}
        </Field>

        {/* For bots only. People never see it, and screen readers skip it. */}
        <div aria-hidden="true" className="absolute -left-[9999px] top-0 h-px w-px overflow-hidden">
          <label>
            Website
            <input name="website" tabIndex={-1} autoComplete="off" />
          </label>
        </div>

        <div className="flex flex-col gap-4 sm:col-span-2 sm:flex-row sm:items-center sm:justify-between">
          <button
            type="submit"
            className="inline-flex min-h-14 items-center justify-center rounded-full bg-brand px-9 text-lg font-bold text-on-brand transition-colors hover:bg-accent disabled:opacity-60"
          >
            {sending ? "Sending…" : site.form.submit}
          </button>
          <p className="text-base text-muted">{site.form.privacy}</p>
        </div>

        <p role="alert" className="text-lg text-danger-text sm:col-span-2 empty:hidden">
          {status.kind === "error" ? status.message : ""}
        </p>
      </fieldset>
    </form>
  );
}
