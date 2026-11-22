import type { MetadataRoute } from "next";

/**
 * The staff app: keep everything out of search engines. The public site answers with its own
 * robots.txt (app/site/robots.txt), which the proxy serves in place of this one on the public host.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
