import { Container } from "./container";
import { EnquiryForm } from "./enquiry-form";
import { fullAddress, hoursLine, mapsUrl, site } from "@/lib/site/content";

const linkClass = "rounded-sm text-chalk underline decoration-chalk/30 decoration-2 underline-offset-[6px] hover:decoration-brand";

/** The /contact page: how to reach the venue, then the message form (lands in Admin → Enquiries). */
export function Contact() {
  return (
    <section aria-labelledby="contact-heading">
      <Container className="grid gap-12 pb-20 pt-8 sm:pb-28 sm:pt-14 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
        <div>
          <h1 id="contact-heading" className="display text-[clamp(3rem,11vw,7rem)] text-chalk">
            {site.contact.heading}
          </h1>
          <div className="chalk-rule mt-7" />
          <p className="mt-7 max-w-md text-xl leading-relaxed text-muted sm:text-2xl sm:leading-relaxed">{site.contact.lead}</p>

          <ul className="mt-10 space-y-3 text-xl">
            {site.phone ? (
              <li>
                <a href={`tel:${site.phone.replace(/[^\d+]/g, "")}`} className={linkClass}>
                  {site.phone}
                </a>
              </li>
            ) : null}
            {site.email ? (
              <li>
                <a href={`mailto:${site.email}`} className={linkClass}>
                  {site.email}
                </a>
              </li>
            ) : null}
            {site.social?.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {s.label}
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>

          <address className="mt-10 space-y-2 text-xl not-italic text-accent">
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {fullAddress}
              <span className="sr-only"> (opens Google Maps in a new tab)</span>
            </a>
            {hoursLine ? <p className="text-muted">{hoursLine}</p> : null}
          </address>
        </div>
        <EnquiryForm kind="contact" />
      </Container>
    </section>
  );
}
