import { Container } from "./container";
import { formatTime, site } from "@/lib/site/content";

export function Expect() {
  const items: { term: string; detail: string }[] = [
    { term: "Tables", detail: `${site.tableCount} pool tables.${site.tables ? ` ${site.tables}` : ""}` },
    { term: "Counter", detail: `${site.snacks} are sold at the counter.` },
    { term: "Paying", detail: `${site.payment}.` },
    { term: "Opened", detail: `${site.openedOn}.` },
  ];
  if (site.hours) {
    items.push({
      term: "Hours",
      detail: site.hours.map((r) => `${r.label}, ${formatTime(r.opens)} to ${formatTime(r.closes)}`).join(". ") + ".",
    });
  }
  if (site.bookings) items.push({ term: "Bookings", detail: site.bookings });
  if (site.parking) items.push({ term: "Parking", detail: site.parking });
  if (site.ageRules) items.push({ term: "Ages", detail: site.ageRules });

  return (
    <section id="what-to-expect" aria-labelledby="expect-heading" className="scroll-mt-16 border-t border-line bg-surface">
      <Container className="py-20 sm:py-28">
        <h2 id="expect-heading" className="text-3xl font-bold tracking-tight sm:text-4xl">
          {site.expect.heading}
        </h2>
        <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">{site.expect.lead}</p>
        <dl className="mt-12 grid gap-x-12 gap-y-10 sm:grid-cols-2">
          {items.map((i) => (
            <div key={i.term} className="border-t border-line pt-5">
              <dt className="text-sm font-semibold uppercase tracking-wider text-brand">{i.term}</dt>
              <dd className="mt-2 text-xl leading-snug text-chalk">{i.detail}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
