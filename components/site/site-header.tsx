import Image from "next/image";
import { Container } from "./container";
import { site } from "@/lib/site/content";

const link = "hidden rounded-md px-3 py-2 text-lg font-semibold text-chalk/80 transition-colors hover:text-chalk sm:inline-block";

export function SiteHeader() {
  return (
    <header>
      <Container className="flex h-20 items-center justify-between gap-3 sm:h-24">
        <a href="#" aria-label={`${site.name}, back to top`} className="shrink-0 rounded-md">
          <Image src="/brand/logo-on-dark.png" alt={site.name} width={139} height={54} className="h-11 w-auto sm:h-[3.4rem]" priority />
        </a>
        <nav aria-label="Page sections" className="flex items-center gap-1">
          <a href="#price" className={link}>
            Price
          </a>
          <a href="#tables" className={link}>
            Tables
          </a>
          <a
            href="#find-us"
            className="ml-2 inline-flex min-h-11 items-center rounded-full border-2 border-chalk/25 px-5 text-base font-bold text-chalk transition-colors hover:border-brand"
          >
            Find us
          </a>
        </nav>
      </Container>
    </header>
  );
}
