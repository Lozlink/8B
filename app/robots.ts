import type { MetadataRoute } from "next";

/** Internal staff tool: keep everything out of search engines. */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}
