import { Ball } from "./ball";
import { Container } from "./container";
import { site } from "@/lib/site/content";

/** Seven tables, shown as the seven balls before the black; then what's at the counter. */
export function Tables() {
  const numbers = Array.from({ length: site.tableCount }, (_, i) => i + 1);
  return (
    <section id="tables" aria-labelledby="tables-heading" className="scroll-mt-20 bg-surface">
      <Container className="grid gap-x-16 gap-y-16 py-20 sm:py-28 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <h2 id="tables-heading" className="display text-[clamp(2.75rem,8vw,5rem)] text-chalk">
            {site.tables.heading}
          </h2>
          <p className="mt-9 flex flex-wrap gap-2.5 sm:gap-3" role="img" aria-label={`${site.tableCount} tables`}>
            {numbers.map((n) => (
              <Ball key={n} n={n} style={{ "--d": "clamp(2.2rem, 9vw, 4rem)" } as React.CSSProperties} />
            ))}
          </p>
          <p className="mt-9 max-w-xl text-xl leading-relaxed text-muted">
            {site.tables.lead}
            {site.tables_note ? ` ${site.tables_note}` : ""}
          </p>
        </div>
        <div className="lg:pt-3">
          <h2 className="display text-[clamp(2.25rem,6vw,3.5rem)] text-chalk">{site.counter.heading}</h2>
          <p className="mt-6 max-w-md text-xl leading-relaxed text-muted">{site.counter.lead}</p>
        </div>
      </Container>
    </section>
  );
}
