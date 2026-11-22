import Image from "next/image";
import { Container } from "./container";
import { fullAddress, rateText, site } from "@/lib/site/content";

export function Hero() {
  return (
    <section aria-labelledby="hero-heading" className="overflow-hidden">
      <Container className="grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1.25fr_1fr] lg:gap-8 lg:py-28">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-brand">
            Fairfield NSW &middot; Open since {site.openedOn}
          </p>
          <h1
            id="hero-heading"
            className="mt-5 text-balance text-5xl font-black leading-[0.95] tracking-tight text-chalk sm:text-7xl lg:text-8xl"
          >
            {site.hero.heading}
          </h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted sm:text-xl">{site.hero.lead}</p>
          <p className="mt-4 text-base text-accent">
            {rateText} per table. {fullAddress}.
          </p>
          <div className="mt-9 flex flex-wrap gap-3">
            <a
              href="#pricing"
              className="inline-flex min-h-12 items-center rounded-lg bg-brand px-6 text-base font-bold text-on-brand transition-colors hover:bg-brand-dark"
            >
              {site.hero.primaryCta}
            </a>
            <a
              href="#find-us"
              className="inline-flex min-h-12 items-center rounded-lg border border-line px-6 text-base font-semibold text-chalk transition-colors hover:border-accent"
            >
              {site.hero.secondaryCta}
            </a>
          </div>
        </div>

        <div className="mx-auto flex aspect-square w-60 items-center justify-center rounded-full bg-brand sm:w-80 lg:w-full lg:max-w-md lg:justify-self-end">
          <Image
            src="/brand/ball.png"
            alt=""
            width={730}
            height={730}
            sizes="(min-width: 1024px) 340px, (min-width: 640px) 230px, 170px"
            className="h-auto w-[72%] drop-shadow-[0_18px_24px_rgba(0,0,0,0.45)]"
            priority
          />
        </div>
      </Container>
    </section>
  );
}
