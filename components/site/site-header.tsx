import Image from "next/image";
import { Container } from "./container";
import { site } from "@/lib/site/content";

const link =
  "rounded-md px-2 py-2 text-sm font-medium text-muted transition-colors hover:text-chalk sm:px-3";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur supports-[backdrop-filter]:bg-bg/75">
      <Container className="flex h-16 items-center justify-between gap-3">
        <a href="#" aria-label={`${site.name}, back to top`} className="shrink-0 rounded-md">
          <Image src="/brand/logo-on-dark.png" alt={site.name} width={83} height={32} className="h-8 w-auto" priority />
        </a>
        <nav aria-label="Page sections" className="flex items-center">
          <a href="#pricing" className={link}>
            Pricing
          </a>
          <a href="#what-to-expect" className={`${link} hidden sm:inline-block`}>
            What to expect
          </a>
          <a href="#find-us" className={link}>
            Find us
          </a>
          <a href="#faq" className={link}>
            Questions
          </a>
        </nav>
      </Container>
    </header>
  );
}
