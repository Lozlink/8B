import Image from "next/image";
import { Container } from "./container";
import { SiteLink } from "./site-link";
import { site } from "@/lib/site/content";

const textLink = "rounded-md px-3 py-2 text-lg font-semibold text-chalk/80 transition-colors hover:text-chalk";
/** Sections of the home page: there's room for these from tablet width up. */
const sectionLink = `hidden md:inline-block ${textLink}`;

export function SiteHeader() {
  return (
    <header>
      <Container className="flex h-20 items-center justify-between gap-3 sm:h-24">
        <SiteLink href="/" aria-label={`${site.name}, home`} className="shrink-0 rounded-md">
          <Image src="/brand/logo-on-dark.png" alt={site.name} width={139} height={54} className="h-11 w-auto sm:h-[3.4rem]" priority />
        </SiteLink>
        <nav aria-label="Site" className="flex items-center gap-1">
          <SiteLink href="/#price" className={sectionLink}>
            Price
          </SiteLink>
          <SiteLink href="/#tables" className={sectionLink}>
            Tables
          </SiteLink>
          {/* Its own page, so it stays on a phone too. */}
          <SiteLink href="/functions" className={`inline-block ${textLink}`}>
            {site.functions.navLabel}
          </SiteLink>
          {/* On a phone it's in the footer and the Find us block instead. */}
          <SiteLink href="/contact" className={`hidden sm:inline-block ${textLink}`}>
            {site.contact.navLabel}
          </SiteLink>
          <SiteLink
            href="/#find-us"
            className="ml-2 inline-flex min-h-11 items-center rounded-full border-2 border-chalk/25 px-5 text-base font-bold text-chalk transition-colors hover:border-brand"
          >
            Find us
          </SiteLink>
        </nav>
      </Container>
    </header>
  );
}
