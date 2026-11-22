import { Container } from "./container";
import { formatTime, mapsUrl, site } from "@/lib/site/content";

const linkClass = "rounded-sm text-chalk underline decoration-line underline-offset-4 hover:decoration-brand";

export function FindUs() {
  const { address } = site;
  const hasContact = Boolean(site.phone || site.email || site.social?.length);
  return (
    <section id="find-us" aria-labelledby="find-heading" className="scroll-mt-16 border-t border-line">
      <Container className="grid gap-12 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 id="find-heading" className="text-3xl font-bold tracking-tight sm:text-4xl">
            {site.findUs.heading}
          </h2>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">{site.findUs.lead}</p>
          <address className="mt-10 text-3xl font-bold not-italic leading-tight tracking-tight sm:text-4xl">
            {address.unitAndStreet}
            <br />
            {address.suburb} {address.state} {address.postcode}
          </address>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-8 inline-flex min-h-12 items-center rounded-lg bg-brand px-6 text-base font-bold text-on-brand transition-colors hover:bg-brand-dark"
          >
            {site.findUs.mapsCta}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>

        {(site.hours || hasContact) && (
          <div className="space-y-10 self-end">
            {site.hours && (
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-brand">Hours</h3>
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {site.hours.map((r) => (
                    <li key={r.label} className="flex justify-between gap-6 py-4 text-lg">
                      <span>{r.label}</span>
                      <span className="text-accent">
                        {formatTime(r.opens)} to {formatTime(r.closes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasContact && (
              <div>
                <h3 className="text-sm font-semibold uppercase tracking-wider text-brand">Contact</h3>
                <ul className="mt-3 space-y-2 text-lg">
                  {site.phone && (
                    <li>
                      <a href={`tel:${site.phone.replace(/[^\d+]/g, "")}`} className={linkClass}>
                        {site.phone}
                      </a>
                    </li>
                  )}
                  {site.email && (
                    <li>
                      <a href={`mailto:${site.email}`} className={linkClass}>
                        {site.email}
                      </a>
                    </li>
                  )}
                  {site.social?.map((s) => (
                    <li key={s.url}>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
                        {s.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Container>
    </section>
  );
}
