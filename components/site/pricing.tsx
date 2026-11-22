import { Container } from "./container";
import { site } from "@/lib/site/content";

export function Pricing() {
  const rules: { term: string; detail: string }[] = [
    { term: "Per table", detail: "The price is for the table, not for each person." },
    { term: "GST", detail: "Included in the rate." },
    { term: "Every day", detail: "The same rate any day of the week." },
    { term: "Minimum", detail: `${site.minimumMinutes} minutes.` },
    { term: "After that", detail: "You pay for the time you play." },
  ];
  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="scroll-mt-16 border-t border-line">
      <Container className="grid gap-12 py-20 sm:py-28 lg:grid-cols-2 lg:gap-16">
        <div>
          <h2 id="pricing-heading" className="text-3xl font-bold tracking-tight sm:text-4xl">
            {site.pricing.heading}
          </h2>
          <p className="mt-4 max-w-md text-lg leading-relaxed text-muted">{site.pricing.lead}</p>
          <p className="mt-10 flex items-baseline gap-3" aria-label={`$${site.rate.dollars} an ${site.rate.per}, per table`}>
            <span aria-hidden="true" className="text-[6.5rem] font-black leading-none tracking-tighter text-brand sm:text-[9rem]">
              ${site.rate.dollars}
            </span>
            <span aria-hidden="true" className="text-lg font-medium leading-tight text-accent sm:text-2xl">
              an {site.rate.per}
              <br />
              per table
            </span>
          </p>
        </div>
        <dl className="self-end divide-y divide-line border-y border-line">
          {rules.map((r) => (
            <div key={r.term} className="grid gap-1 py-5 sm:grid-cols-[9rem_1fr] sm:gap-6">
              <dt className="text-sm font-semibold uppercase tracking-wider text-muted">{r.term}</dt>
              <dd className="text-lg text-chalk">{r.detail}</dd>
            </div>
          ))}
        </dl>
      </Container>
    </section>
  );
}
