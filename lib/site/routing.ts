/**
 * Which host serves what. Pure: no I/O, so proxy.ts stays a thin wrapper and this can be tested.
 *
 *   8balllounge.com.au       the public site (app/site/**), for customers and search engines
 *   app.8balllounge.com.au   the staff app
 *
 * The staff app used to live on the public host, and the iPads were enrolled there. Their device
 * cookie is tied to that host, so an iPad that still carries it keeps getting the app there, exactly
 * as before, until it is enrolled again on the app host. Everyone else on the public host (no device
 * cookie: customers, Google) gets the site. Nothing has to be switched over on a particular day.
 *
 * Any other host (localhost, a preview deployment) is the app, with the site viewable at /site.
 */

export const SITE_HOST = "8balllounge.com.au";
export const SITE_ORIGIN = `https://${SITE_HOST}`;
export const APP_ORIGIN = `https://app.${SITE_HOST}`;

const WWW_HOST = `www.${SITE_HOST}`;

/** Where the public site's pages live in the app directory. */
const SITE_PREFIX = "/site";

/** The staff app's own pages. On the public host these belong to the app host. */
const APP_PATHS = ["/login", "/enrol", "/unpaid", "/summary", "/admin", "/end-of-day"] as const;

/** "Example.com:3000" → "example.com". */
export function hostname(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

/** true on the public host, with or without www. */
export function isSiteHost(host: string | null | undefined): boolean {
  const h = hostname(host);
  return h === SITE_HOST || h === WWW_HOST;
}

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

export interface RouteInput {
  /** The request's Host header. */
  host: string | null | undefined;
  pathname: string;
  /** The query string, with its "?" (or ""). Carried over on redirects. */
  search?: string;
  /** This browser is an enrolled iPad (it carries the device cookie). */
  hasDevice: boolean;
  /** A staff member is signed in on it. */
  hasSession: boolean;
}

export type RouteDecision =
  /** Serve the request as it is. */
  | { kind: "next" }
  /** Serve this path instead; the address bar doesn't change. */
  | { kind: "rewrite"; pathname: string }
  /** `to` is a path on the same host, or a full URL. `permanent` = 308, else 307. */
  | { kind: "redirect"; to: string; permanent: boolean };

const NEXT: RouteDecision = { kind: "next" };

export function decideRoute(input: RouteInput): RouteDecision {
  const { pathname, hasDevice, hasSession } = input;
  const search = input.search ?? "";
  const host = hostname(input.host);

  // Square POS comes back here in Safari, which shares no cookies with the home-screen app. The
  // page needs none: what it posts is checked by its own signed token. It answers on both hosts,
  // because the address registered with Square may be either.
  if (pathname === "/pos/return") return NEXT;

  // The site's own files (its pages when previewing, its social image) are served where they live.
  if (under(pathname, SITE_PREFIX)) return NEXT;

  // One address for the public site, so search engines see one.
  if (host === WWW_HOST) return { kind: "redirect", to: `${SITE_ORIGIN}${pathname}${search}`, permanent: true };

  if (host === SITE_HOST && !hasDevice) {
    if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return { kind: "rewrite", pathname: `${SITE_PREFIX}${pathname}` };
    // Someone following an old link or bookmark to the app.
    if (APP_PATHS.some((p) => under(pathname, p))) return { kind: "redirect", to: `${APP_ORIGIN}${pathname}${search}`, permanent: false };
    return { kind: "rewrite", pathname: pathname === "/" ? SITE_PREFIX : `${SITE_PREFIX}${pathname}` };
  }

  // The staff app. Optimistic routing only (cookie presence): real authorisation happens in every
  // API route, which verifies the signed cookies and checks the device and staff rows.
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return NEXT;
  if (!hasDevice && pathname !== "/enrol") return { kind: "redirect", to: "/enrol", permanent: false };
  if (hasDevice && !hasSession && pathname !== "/login" && pathname !== "/enrol") return { kind: "redirect", to: "/login", permanent: false };
  return NEXT;
}
