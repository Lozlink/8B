import type { Metadata } from "next";
import { Contact } from "@/components/site/contact";
import { site } from "@/lib/site/content";

const { title, description } = site.contact.meta;
// The home page's share card (app/site/opengraph-image.tsx). Setting openGraph here replaces the
// one inherited from the site layout, so the image has to be named again.
const image = { url: "/site/opengraph-image", width: 1200, height: 630, alt: site.meta.ogAlt };

// On the public host this is /contact (the proxy serves it from /site/contact).
export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: "/contact" },
  openGraph: {
    type: "website",
    url: "/contact",
    siteName: site.name,
    locale: "en_AU",
    title,
    description,
    images: [image],
  },
  twitter: { card: "summary_large_image", title, description, images: [image] },
};

export default function ContactPage() {
  return <Contact />;
}
