import { Container } from "./container";
import { formatTime, mapsUrl, site } from "@/lib/site/content";

const linkClass = "rounded-sm text-chalk underline decoration-chalk/30 decoration-2 underline-offset-[6px] hover:decoration-brand";

export function FindUs() {
  const { address } = site;
  const hasContact = Boolean(site.phone || site.email || site.social?.length);
  return (
    <section id="find-us" aria-labelledby="find-heading" className="scroll-mt-20">
      <Container className="grid gap-14 py-20 sm:py-28 lg:grid-cols-[1.35fr_1fr] lg:gap-16">
        <div>
          <h2 id="find-heading" className="display text-[clamp(2.75rem,9vw,6rem)] text-chalk">
            {site.findUs.heading}
          </h2>
          <div className="chalk-rule mt-7" />
          <p className="mt-7 max-w-xl text-xl leading-relaxed text-muted sm:text-2xl sm:leading-relaxed">{site.findUs.lead}</p>
          <address className="mt-9 text-2xl font-semibold not-italic leading-snug text-accent sm:text-3xl">
            {address.unitAndStreet}
            <br />
            {address.suburb} {address.state} {address.postcode}
          </address>
          <a
            href={mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-9 inline-flex min-h-14 items-center rounded-full bg-brand px-8 text-lg font-bold text-on-brand transition-colors hover:bg-accent"
          >
            {site.findUs.mapsCta}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </div>

        {(site.hours || hasContact) && (
          <div className="space-y-12 self-end">
            {site.hours && (
              <div>
                <h3 className="display text-3xl text-chalk">Open</h3>
                <ul className="mt-4 space-y-3 text-xl">
                  {site.hours.map((r) => (
                    <li key={r.label} className="flex justify-between gap-6">
                      <span className="text-muted">{r.label}</span>
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
                <h3 className="display text-3xl text-chalk">Say g&apos;day</h3>
                <ul className="mt-4 space-y-3 text-xl">
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
