import type { CSSProperties } from "react";
import { Ball } from "./ball";
import { Container } from "./container";
import { hoursLine, rateText, site } from "@/lib/site/content";

/**
 * Where each ball starts (racked) and comes to rest, as percentages of the cloth. Two layouts: a
 * tall table on a phone, with the balls under the words, and a wide one with the balls beside them.
 */
interface Spot {
  n: number | "cue";
  /** phone: rack, rest */
  r: [number, number];
  to: [number, number];
  /** wide: rack, rest */
  lr: [number, number];
  lto: [number, number];
  spin: number;
}

const SPOTS: Spot[] = [
  { n: 1, r: [40, 79], to: [14, 73], lr: [71, 50], lto: [70, 19], spin: -420 },
  { n: 2, r: [48, 75], to: [86, 70], lr: [74.6, 44.5], lto: [90, 22], spin: 380 },
  { n: 3, r: [48, 83], to: [55, 74], lr: [74.6, 55.5], lto: [81, 35], spin: -260 },
  { n: 4, r: [56, 71], to: [74, 86], lr: [78.2, 39], lto: [93, 60], spin: 300 },
  { n: 8, r: [56, 79], to: [31, 67], lr: [78.2, 50], lto: [80, 62], spin: -200 },
  { n: 5, r: [56, 87], to: [38, 85], lr: [78.2, 61], lto: [71, 49], spin: 460 },
  { n: 6, r: [64, 75], to: [89, 94], lr: [81.8, 44.5], lto: [86, 82], spin: -340 },
  { n: 7, r: [64, 83], to: [58, 95], lr: [81.8, 55.5], lto: [69, 85], spin: 240 },
];

const pc = (v: number) => `${v}%`;

function vars(s: Spot): CSSProperties {
  return {
    "--rx": pc(s.r[0]),
    "--ry": pc(s.r[1]),
    "--x": pc(s.to[0]),
    "--y": pc(s.to[1]),
    "--lrx": pc(s.lr[0]),
    "--lry": pc(s.lr[1]),
    "--lx": pc(s.lto[0]),
    "--ly": pc(s.lto[1]),
    "--spin": `${s.spin}deg`,
  } as CSSProperties;
}

// The cue ball: where it comes from, where it meets the rack, where it ends up.
const CUE = {
  "--sx": "-12%",
  "--sy": "79%",
  "--hx": "33%",
  "--hy": "79%",
  "--x": "15%",
  "--y": "92%",
  "--lsx": "-8%",
  "--lsy": "50%",
  "--lhx": "67.4%",
  "--lhy": "50%",
  "--lx": "63%",
  "--ly": "68%",
} as CSSProperties;

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="pb-6 pt-4 sm:pt-6">
      <Container>
        <div className="pool-table">
          <div className="felt min-h-[48rem] sm:min-h-[46rem] lg:min-h-[min(78vh,44rem)]">
            <div className="relative z-10 px-6 pb-[19rem] pt-10 sm:px-12 sm:pt-14 lg:max-w-[64%] lg:px-16 lg:pb-16 lg:pt-20">
              <h1 id="hero-heading" className="display text-[clamp(3.6rem,17vw,5.75rem)] text-chalk lg:text-[clamp(4.5rem,7.4vw,7.25rem)]">
                {site.hero.heading}
              </h1>
              <p className="mt-6 max-w-md text-xl font-medium leading-snug text-chalk/90 sm:text-2xl">{site.hero.lead}</p>
              {hoursLine ? <p className="mt-3 text-lg font-semibold text-accent sm:text-xl">{hoursLine}</p> : null}
              <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-4">
                <a
                  href="#find-us"
                  className="inline-flex min-h-14 items-center rounded-full bg-brand px-8 text-lg font-bold text-on-brand transition-colors hover:bg-accent"
                >
                  {site.hero.primaryCta}
                </a>
                <a href="#price" className="rounded-sm text-lg font-semibold text-chalk underline decoration-chalk/40 decoration-2 underline-offset-[6px] hover:decoration-brand">
                  {rateText} a table
                </a>
              </div>
            </div>

            <div className="break-field">
              <Ball n="cue" style={CUE} />
              {SPOTS.map((s) => (
                <Ball key={s.n} n={s.n} style={vars(s)} />
              ))}
            </div>
          </div>
          <span className="pocket pocket-tl" />
          <span className="pocket pocket-tr" />
          <span className="pocket pocket-m1" />
          <span className="pocket pocket-m2" />
          <span className="pocket pocket-bl" />
          <span className="pocket pocket-br" />
        </div>
      </Container>
    </section>
  );
}
