import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootHarness, type Harness } from "./helpers/harness";
import { audits } from "./helpers/util";
import {
  countOpenEnquiries,
  createEnquiry,
  listEnquiries,
  notifyEnquiry,
  setEnquiryHandled,
  venueToday,
  type StoredEnquiry,
} from "@/lib/server/enquiries";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { setMailerForTests, type Email } from "@/lib/server/mailer";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

const TZ = "Australia/Sydney";
const today = () => venueToday(TZ);
const daysFromToday = (n: number) => {
  const [y, m, d] = today().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const good = { kind: "functions", name: "Pat Jones", email: "pat@example.com" };
const contact = { kind: "contact", name: "Sam Lee", email: "sam@example.com", message: "Do you have a 9-foot table?" };
const send = (body: Record<string, unknown>, ip: string | null = "203.0.113.7") => createEnquiry(body, ip);
const rows = () => h.raw<{ n: number }>(null, "select count(*)::int as n from public.enquiries").then((r) => r[0].n);

describe("sending an enquiry", () => {
  it("keeps what was sent, tidied, with blanks as nothing", async () => {
    const r = await send({
      kind: "functions",
      name: "  Pat \n Jones ",
      company: "  ",
      email: " pat@example.com ",
      phone: "",
      preferredDate: daysFromToday(10),
      groupSize: 18,
      message: "  First line\r\n\r\n\r\n\r\nSecond   line\u0007  ",
      website: "",
    });
    expect(r).toMatchObject({ stored: true });
    const [e] = await listEnquiries();
    expect(e).toMatchObject({
      kind: "functions",
      name: "Pat Jones",
      company: null,
      email: "pat@example.com",
      phone: null,
      preferredDate: daysFromToday(10),
      groupSize: 18,
      message: "First line\n\nSecond line",
      handled: null,
    });
  });

  it("only a name and an email are needed", async () => {
    await send(good);
    expect(await rows()).toBe(1);
  });

  it.each([
    [{ ...good, name: " \n " }, "Add your name."],
    [{ ...good, name: "n".repeat(81) }, "80 characters"],
    [{ ...good, email: "" }, "Add an email"],
    [{ ...good, email: "pat@example" }, "doesn't look right"],
    // Would add a cc to the mailto: link in the staff app.
    [{ ...good, email: "pat@example.com?cc=x@evil.test" }, "doesn't look right"],
    [{ ...good, phone: "call me" }, "phone number"],
    [{ ...good, phone: "12" }, "phone number"],
    [{ ...good, preferredDate: "2026-02-30" }, "date doesn't look right"],
    [{ ...good, preferredDate: "12/12/2026" }, "date doesn't look right"],
    [{ ...good, groupSize: 0 }, "between 1 and 500"],
    [{ ...good, groupSize: 501 }, "between 1 and 500"],
    [{ ...good, message: "m".repeat(2001) }, "under 2000"],
  ])("refuses %o and keeps nothing", async (body, message) => {
    await expect(send(body)).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
    expect(await rows()).toBe(0);
  });

  it("takes today and dates up to two years out, not yesterday or later than that", async () => {
    await send({ ...good, preferredDate: today() });
    await send({ ...good, preferredDate: daysFromToday(700) }, "203.0.113.8");
    await expect(send({ ...good, preferredDate: daysFromToday(-1) }, "203.0.113.9")).rejects.toMatchObject({ status: 400 });
    await expect(send({ ...good, preferredDate: daysFromToday(800) }, "203.0.113.9")).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toBe(2);
  });

  it("an unknown or missing form kind is refused", async () => {
    await expect(send({ ...good, kind: "newsletter" })).rejects.toMatchObject({ status: 400 });
    await expect(send({ name: "Pat", email: "pat@example.com" })).rejects.toMatchObject({ status: 400 });
    expect(await rows()).toBe(0);
  });

  it("a bot that fills the hidden field is told it worked, and nothing is kept", async () => {
    expect(await send({ ...good, website: "https://spam.example" })).toEqual({ stored: false });
    expect(await rows()).toBe(0);
  });
});

describe("the contact form", () => {
  it("is kept with its kind, and needs a message", async () => {
    await send(contact);
    const [e] = await listEnquiries();
    expect(e).toMatchObject({ kind: "contact", name: "Sam Lee", message: "Do you have a 9-foot table?" });
    await expect(send({ ...contact, message: "  \n " }, "198.51.100.3")).rejects.toMatchObject({
      status: 400,
      message: "Add a message.",
    });
  });

  it("drops the functions-only details if they're sent anyway", async () => {
    await send({ ...contact, company: "Acme", preferredDate: daysFromToday(3), groupSize: 12 });
    const [e] = await listEnquiries();
    expect(e).toMatchObject({ company: null, preferredDate: null, groupSize: null });
  });

  it("the database holds a contact message to the same rules", async () => {
    const insert = (cols: string, vals: string) =>
      h.rawError(null, `insert into public.enquiries (kind, name, email, source_hash${cols}) values ('contact', 'A', 'a@b.co', repeat('a', 64)${vals})`);
    expect((await insert("", "")).code).toBe("23514");
    expect((await insert(", message, group_size", ", 'hi', 4")).code).toBe("23514");
  });
});

describe("slowing down repeat senders", () => {
  it("three an hour from one sender, whichever form; others aren't affected", async () => {
    await send(good);
    await send(contact);
    await send(good);
    await expect(send(good)).rejects.toMatchObject({ status: 429 });
    await expect(send(good, "198.51.100.1")).resolves.toMatchObject({ stored: true });
    expect(await rows()).toBe(4);
  });

  it("keeps a hash of the address, never the address itself", async () => {
    await send(good, "203.0.113.7");
    const [r] = await h.raw<{ source_hash: string }>(null, "select source_hash from public.enquiries");
    expect(r.source_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.source_hash).not.toContain("203.0.113.7");
  });
});

describe("dealing with an enquiry", () => {
  const firstId = async () => (await listEnquiries())[0].id;

  it("a manager marks it dealt with, and can reopen it; both are audited", async () => {
    await send(good);
    const id = await firstId();
    expect(await countOpenEnquiries()).toBe(1);

    await setEnquiryHandled(h.staff.managerActor, h.staff.manager, id, true);
    const [done] = await listEnquiries();
    expect(done.handled).toMatchObject({ byName: "Mia Manager" });
    expect(await countOpenEnquiries()).toBe(0);
    await expect(setEnquiryHandled(h.staff.managerActor, h.staff.manager, id, true)).rejects.toMatchObject({ status: 409 });

    await setEnquiryHandled(h.staff.managerActor, h.staff.manager, id, false);
    expect((await listEnquiries())[0].handled).toBeNull();
    expect(await countOpenEnquiries()).toBe(1);

    const log = await audits(h, id);
    expect(log.map((a) => a.action)).toEqual(["enquiry.handled", "enquiry.reopened"]);
    // No contact details in the audit log.
    expect(JSON.stringify(log)).not.toContain("pat@example.com");
  });

  it("open ones come first", async () => {
    await send({ ...good, name: "Older" });
    await send({ ...good, name: "Newer" }, "198.51.100.2");
    expect((await listEnquiries()).map((e) => e.name)).toEqual(["Newer", "Older"]);
    await setEnquiryHandled(h.staff.managerActor, h.staff.manager, await firstId(), true);
    expect((await listEnquiries()).map((e) => e.name)).toEqual(["Older", "Newer"]);
  });

  it("an unknown id is a 404", async () => {
    await expect(
      setEnquiryHandled(h.staff.managerActor, h.staff.manager, "00000000-0000-4000-8000-00000000abcd", true),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("what the database allows", () => {
  it("the app can't change what was sent, or delete it; the public API roles can't see it", async () => {
    await send(good);
    expect((await h.rawError("timer_app", "update public.enquiries set name = 'Someone else'")).code).toBe("42501");
    expect((await h.rawError("timer_app", "delete from public.enquiries")).code).toBe("42501");
    expect((await h.rawError("anon", "select * from public.enquiries")).code).toBe("42501");
    expect((await h.rawError(null, "delete from public.enquiries")).message).toContain("never deleted");
  });
});

describe("emailing the venue", () => {
  const SES = {
    SES_AWS_REGION: "ap-southeast-2",
    SES_AWS_ACCESS_KEY_ID: "AKIATEST",
    SES_AWS_SECRET_ACCESS_KEY: "secret",
    ENQUIRY_FROM_EMAIL: "8 Ball Lounge <enquiries@8balllounge.com.au>",
  };
  let sent: Email[];

  const configure = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries(vars)) process.env[k] = v;
    resetEnvCacheForTests();
  };
  const stored = async (body: Record<string, unknown>, ip?: string): Promise<StoredEnquiry> => {
    const r = await send(body, ip);
    if (!r.stored) throw new Error("expected it to be stored");
    return r.enquiry;
  };

  beforeEach(() => {
    sent = [];
    setMailerForTests(async (_cfg, email) => {
      sent.push(email);
    });
  });
  afterEach(() => {
    for (const k of [...Object.keys(SES), "ENQUIRY_TO_EMAIL"]) delete process.env[k];
    resetEnvCacheForTests();
    setMailerForTests(null);
    vi.restoreAllMocks();
  });

  it("without SES set up nothing is sent, and the enquiry is still kept", async () => {
    const e = await stored(good);
    expect(await notifyEnquiry(e)).toBe("not_configured");
    expect(sent).toEqual([]);
    expect(await rows()).toBe(1);
  });

  it("half set up is treated as not set up, and says so in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    configure({ SES_AWS_REGION: "ap-southeast-2" });
    expect(await notifyEnquiry(await stored(good))).toBe("not_configured");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("SES"), expect.stringContaining("SES_AWS_ACCESS_KEY_ID"));
  });

  it("a functions enquiry goes to the site's address by default, with Reply going to the sender", async () => {
    configure(SES);
    const e = await stored({ ...good, company: "Acme", preferredDate: daysFromToday(10), groupSize: 20, phone: "0400 000 000" });
    expect(await notifyEnquiry(e)).toBe("sent");
    expect(sent).toHaveLength(1);
    const [m] = sent;
    expect(m).toMatchObject({ from: SES.ENQUIRY_FROM_EMAIL, to: "info@8balllounge.com.au", replyTo: "pat@example.com" });
    expect(m.subject).toMatch(/^Functions enquiry: Pat Jones \(Acme\) · \w{3}, \d{1,2} \w{3} \d{4} · 20 people$/);
    expect(m.text).toContain("Phone: 0400 000 000");
    expect(m.text).toContain("How many: 20");
    expect(m.text).toContain("https://app.8balllounge.com.au/admin");
  });

  it("ENQUIRY_TO_EMAIL sends it somewhere else", async () => {
    configure({ ...SES, ENQUIRY_TO_EMAIL: "owner@example.com" });
    await notifyEnquiry(await stored(good));
    expect(sent[0].to).toBe("owner@example.com");
  });

  it("a contact message says so, leaves out the functions details, and keeps the message's lines", async () => {
    configure(SES);
    await notifyEnquiry(await stored({ ...contact, message: "Line one\nLine two" }));
    const [m] = sent;
    expect(m.subject).toBe("Message from Sam Lee");
    expect(m.text).not.toContain("How many");
    expect(m.text).toContain("Message:\nLine one\nLine two");
    expect(m.html).toContain("Line one<br>Line two");
  });

  it("what the sender typed can't become markup in the email", async () => {
    configure(SES);
    await notifyEnquiry(await stored({ ...contact, name: "<b>Sam</b>", message: '<script>alert("x")</script>' }));
    expect(sent[0].html).not.toContain("<script>");
    expect(sent[0].html).toContain("&lt;script&gt;");
    expect(sent[0].html).toContain("&lt;b&gt;Sam&lt;/b&gt;");
  });

  it("a failed send is logged by id only and never thrown", async () => {
    configure(SES);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    setMailerForTests(async () => {
      throw new Error("SES is down");
    });
    const e = await stored(good);
    expect(await notifyEnquiry(e)).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("email failed"), { id: e.id }, expect.any(Error));
    expect(JSON.stringify(log.mock.calls)).not.toContain("pat@example.com");
    expect(await countOpenEnquiries()).toBe(1);
  });
});
