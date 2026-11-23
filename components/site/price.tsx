import { Ball } from "./ball";
import { Container } from "./container";
import { site } from "@/lib/site/content";

/** $25 between `players`, as "$12.50" or "$5". Only used for counts that divide to whole cents. */
function share(players: number): string {
  const cents = Math.round((site.rate.dollars * 100) / players);
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
}

export function Price() {
  return (
    <section id="price" aria-labelledby="price-heading" className="scroll-mt-20">
      <Container className="py-20 sm:py-28">
        <h2 id="price-heading" className="display text-[clamp(2.5rem,7.6vw,5.4rem)] text-chalk">
          {site.price.heading.map((line) => (
            // One line each where there is room; on a phone they run on as one sentence.
            <span key={line} className="sm:block">
              {line}{" "}
            </span>
          ))}
        </h2>
        <div className="chalk-rule mt-7" />
        <p className="mt-7 max-w-2xl text-xl leading-relaxed text-muted sm:text-2xl sm:leading-relaxed">{site.price.lead}</p>

        <ul className="mt-12 grid gap-4 sm:grid-cols-3">
          {site.price.splits.map((s) => (
            <li key={s.players} className="rounded-3xl bg-surface px-7 py-7">
              <p className="flex flex-wrap gap-1.5" aria-hidden="true">
                {Array.from({ length: s.players }, (_, i) => (
                  <Ball key={i} n="cue" style={{ "--d": "1.35rem" } as React.CSSProperties} />
                ))}
              </p>
              <p className="mt-5 text-lg font-medium text-muted">{s.line}</p>
              <p className="display mt-1 text-6xl text-brand sm:text-7xl">{share(s.players)}</p>
              <p className="mt-1 text-lg text-accent">each, for an hour</p>
            </li>
          ))}
        </ul>
        <p className="mt-8 text-lg text-muted">{site.price.small}</p>
      </Container>
    </section>
  );
}
