import type { Metadata } from "next";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { site } from "@/lib/site/content";

// Overrides the staff app's noindex and installable-app settings from app/layout.tsx.
export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { absolute: site.meta.title },
  description: site.meta.description,
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  appleWebApp: false,
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    locale: "en_AU",
    title: site.meta.title,
    description: site.meta.description,
  },
  twitter: {
    card: "summary_large_image",
    title: site.meta.title,
    description: site.meta.description,
  },
};

export default function SiteLayout({ children }: LayoutProps<"/site">) {
  return (
    <>
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-brand px-4 py-3 font-bold text-on-brand focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}
