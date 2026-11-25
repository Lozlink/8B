"use client";

import { useEffect, useRef, type AnchorHTMLAttributes } from "react";

/**
 * A link between the public site's pages, written as the address on the public host ("/",
 * "/#price", "/functions"). Off the public host (localhost, a preview) the site lives under /site,
 * so once the page has loaded there the link is pointed at /site/… instead. The built HTML always
 * carries the public address, which is the one search engines see.
 */
export function SiteLink({ href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const { pathname } = window.location;
    if (!ref.current || !(pathname === "/site" || pathname.startsWith("/site/"))) return;
    const hashAt = href.indexOf("#");
    const path = hashAt === -1 ? href : href.slice(0, hashAt);
    const hash = hashAt === -1 ? "" : href.slice(hashAt);
    ref.current.setAttribute("href", `/site${path === "/" ? "" : path}${hash}`);
  }, [href]);
  return <a ref={ref} href={href} {...rest} />;
}
