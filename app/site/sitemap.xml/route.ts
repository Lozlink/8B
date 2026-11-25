import { site } from "@/lib/site/content";

export function GET(): Response {
  const pages = ["/", "/functions", "/contact"];
  const urls = pages.map((p) => `  <url>\n    <loc>${site.url}${p}</loc>\n  </url>\n`).join("");
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
}
