import { faqItems, fullAddress, site } from "@/lib/site/content";

/** Search-engine data for the venue and its FAQ. Built only from lib/site/content.ts. */
export function JsonLd() {
  const venue: Record<string, unknown> = {
    "@type": "SportsActivityLocation",
    "@id": `${site.url}/#venue`,
    name: site.name,
    url: `${site.url}/`,
    description: site.meta.description,
    address: {
      "@type": "PostalAddress",
      streetAddress: site.address.unitAndStreet,
      addressLocality: site.address.suburb,
      addressRegion: site.address.state,
      postalCode: site.address.postcode,
      addressCountry: site.address.country,
    },
    geo: { "@type": "GeoCoordinates", latitude: site.geo.latitude, longitude: site.geo.longitude },
    priceRange: "$",
    currenciesAccepted: "AUD",
    paymentAccepted: "Cash, Card",
    hasMap: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${site.name}, ${fullAddress}`)}`,
  };
  if (site.phone) venue.telephone = site.phone;
  if (site.email) venue.email = site.email;
  if (site.social?.length) venue.sameAs = site.social.map((s) => s.url);
  if (site.hours?.length) {
    venue.openingHoursSpecification = site.hours.map((r) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: r.days,
      opens: r.opens,
      closes: r.closes,
    }));
  }

  const data = {
    "@context": "https://schema.org",
    "@graph": [
      venue,
      {
        "@type": "FAQPage",
        mainEntity: faqItems.map((f) => ({
          "@type": "Question",
          name: f.question,
          acceptedAnswer: { "@type": "Answer", text: f.answer },
        })),
      },
    ],
  };

  // "<" is escaped so no value can close the script tag early.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

