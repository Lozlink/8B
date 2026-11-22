import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

// The staff app is kept out of search engines on every host it answers on. The public site's host
// is the one exception (lib/site/routing.ts): the pages it serves to visitors are meant to be found.
// `missing` conditions must all hold, so this header is left off only there.
const publicHosts = ["8balllounge.com.au", "www.8balllounge.com.au"];
const keepOutOfSearch = {
  source: "/:path*",
  missing: publicHosts.map((value) => ({ type: "host" as const, value })),
  headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
};

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  images: {
    // Item pictures from the Square catalogue (lib/square/catalog.ts keeps to the same hosts).
    remotePatterns: [
      { protocol: "https", hostname: "items-images-production.s3.us-west-2.amazonaws.com", pathname: "/files/**", search: "" },
      { protocol: "https", hostname: "items-images-sandbox.s3.us-west-2.amazonaws.com", pathname: "/files/**", search: "" },
    ],
    // A picture in Square never changes at its URL (a new upload gets a new one), so keep resized copies a month.
    minimumCacheTTL: 2_592_000,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, keepOutOfSearch];
  },
};

export default nextConfig;
