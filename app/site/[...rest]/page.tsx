import { notFound } from "next/navigation";

/**
 * Any address on the public site that isn't a page (the proxy serves /anything from
 * /site/anything). Without this the plain framework 404 would show instead of the site's own.
 */
export default function UnknownSitePage() {
  notFound();
}
