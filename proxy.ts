import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@/lib/site/routing";

/**
 * Sends each page request to the public site or the staff app, by host (the rules, and why, are in
 * lib/site/routing.ts). For the app this is optimistic routing only (cookie presence): real
 * authorisation happens in every API route, which verifies the signed cookies and checks the
 * device and staff rows.
 */
export function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const decision = decideRoute({
    host: req.headers.get("host"),
    pathname,
    search,
    hasDevice: req.cookies.has("tt_device"),
    hasSession: req.cookies.has("tt_session"),
  });

  if (decision.kind === "rewrite") {
    const url = req.nextUrl.clone();
    url.pathname = decision.pathname;
    return NextResponse.rewrite(url);
  }
  if (decision.kind === "redirect") {
    return NextResponse.redirect(new URL(decision.to, req.url), decision.permanent ? 308 : 307);
  }
  return NextResponse.next();
}

export const config = {
  // Pages, robots.txt and sitemap.xml: skip API routes, Next internals and static/metadata files.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|apple-icon|.*\\.(?:png|svg|ico|webp|jpg)$).*)",
  ],
};
