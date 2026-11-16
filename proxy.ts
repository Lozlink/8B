import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic routing only (cookie presence). Real authorisation happens in every API route,
 * which verifies the signed cookies and checks the device/staff rows.
 */
export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasDevice = req.cookies.has("tt_device");
  const hasSession = req.cookies.has("tt_session");

  if (!hasDevice && pathname !== "/enrol") {
    return NextResponse.redirect(new URL("/enrol", req.url));
  }
  if (hasDevice && !hasSession && pathname !== "/login" && pathname !== "/enrol") {
    return NextResponse.redirect(new URL("/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: skip API routes, Next internals and static/metadata files.
  matcher: [
    "/((?!api|_next/static|_next/image|favicon.ico|manifest.webmanifest|robots.txt|icon|apple-icon|.*\\.(?:png|svg|ico|webp|jpg)$).*)",
  ],
};
