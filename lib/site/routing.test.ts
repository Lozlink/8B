import { describe, expect, it } from "vitest";
import { APP_ORIGIN, SITE_ORIGIN, decideRoute, hostname, isSiteHost, type RouteInput } from "./routing";

const at = (host: string, pathname: string, over: Partial<RouteInput> = {}) =>
  decideRoute({ host, pathname, hasDevice: false, hasSession: false, ...over });

const SITE = "8balllounge.com.au";
const APP = "app.8balllounge.com.au";
const next = { kind: "next" };

describe("hostname / isSiteHost", () => {
  it("ignores case and the port", () => {
    expect(hostname("8BallLounge.com.au:443")).toBe(SITE);
    expect(hostname(null)).toBe("");
  });
  it("knows the public host, with and without www, and nothing else", () => {
    expect(isSiteHost(SITE)).toBe(true);
    expect(isSiteHost(`www.${SITE}`)).toBe(true);
    expect(isSiteHost(APP)).toBe(false);
    expect(isSiteHost("localhost:3000")).toBe(false);
    expect(isSiteHost(`evil-${SITE}`)).toBe(false);
  });
});

describe("the public host, for a visitor", () => {
  it("serves the site at the root", () => {
    expect(at(SITE, "/")).toEqual({ kind: "rewrite", pathname: "/site" });
  });
  it("serves any other page from under /site, so an unknown one is the site's own 404", () => {
    expect(at(SITE, "/pricing")).toEqual({ kind: "rewrite", pathname: "/site/pricing" });
  });
  it("serves the site's robots.txt and sitemap", () => {
    expect(at(SITE, "/robots.txt")).toEqual({ kind: "rewrite", pathname: "/site/robots.txt" });
    expect(at(SITE, "/sitemap.xml")).toEqual({ kind: "rewrite", pathname: "/site/sitemap.xml" });
  });
  it("sends old links to the app over to the app host, query and all", () => {
    expect(at(SITE, "/login")).toEqual({ kind: "redirect", to: `${APP_ORIGIN}/login`, permanent: false });
    expect(at(SITE, "/summary", { search: "?date=2026-11-22" })).toEqual({
      kind: "redirect",
      to: `${APP_ORIGIN}/summary?date=2026-11-22`,
      permanent: false,
    });
    expect(at(SITE, "/admin/x")).toMatchObject({ kind: "redirect", to: `${APP_ORIGIN}/admin/x` });
  });
  it("does not mistake a site page for an app page by its first letters", () => {
    expect(at(SITE, "/administration")).toEqual({ kind: "rewrite", pathname: "/site/administration" });
  });
  it("never sends a visitor to enrol", () => {
    for (const p of ["/", "/anything", "/robots.txt"]) expect(at(SITE, p)).not.toMatchObject({ to: "/enrol" });
  });
  it("sends www to the bare domain for good", () => {
    expect(at(`www.${SITE}`, "/", { search: "?x=1" })).toEqual({ kind: "redirect", to: `${SITE_ORIGIN}/?x=1`, permanent: true });
  });
});

describe("the public host, for an iPad enrolled there before the move", () => {
  it("still gets the app", () => {
    expect(at(SITE, "/", { hasDevice: true, hasSession: true })).toEqual(next);
    expect(at(SITE, "/unpaid", { hasDevice: true, hasSession: true })).toEqual(next);
  });
  it("still gets sent to log in", () => {
    expect(at(SITE, "/", { hasDevice: true })).toEqual({ kind: "redirect", to: "/login", permanent: false });
  });
});

describe("the app host", () => {
  it("sends a device that isn't enrolled to enrol", () => {
    expect(at(APP, "/")).toEqual({ kind: "redirect", to: "/enrol", permanent: false });
    expect(at(APP, "/enrol")).toEqual(next);
  });
  it("sends an enrolled device with nobody signed in to log in", () => {
    expect(at(APP, "/summary", { hasDevice: true })).toEqual({ kind: "redirect", to: "/login", permanent: false });
    expect(at(APP, "/login", { hasDevice: true })).toEqual(next);
    expect(at(APP, "/enrol", { hasDevice: true })).toEqual(next);
  });
  it("lets a signed-in device through", () => {
    expect(at(APP, "/end-of-day", { hasDevice: true, hasSession: true })).toEqual(next);
  });
  it("answers robots.txt itself (keep out) instead of redirecting a crawler to enrol", () => {
    expect(at(APP, "/robots.txt")).toEqual(next);
    expect(at(APP, "/sitemap.xml")).toEqual(next);
  });
});

describe("every host", () => {
  it("lets Square POS come back without cookies", () => {
    for (const h of [SITE, APP, "localhost:3000"]) expect(at(h, "/pos/return")).toEqual(next);
  });
  it("serves /site as it is, so the site can be previewed and its social image fetched", () => {
    for (const h of [SITE, APP, "localhost:3000"]) {
      expect(at(h, "/site")).toEqual(next);
      expect(at(h, "/site/opengraph-image")).toEqual(next);
    }
  });
  it("treats an unknown host (local, a preview) as the app", () => {
    expect(at("localhost:3000", "/")).toEqual({ kind: "redirect", to: "/enrol", permanent: false });
    expect(at("some-preview.vercel.app", "/", { hasDevice: true, hasSession: true })).toEqual(next);
  });
});
