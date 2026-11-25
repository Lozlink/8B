import Image from "next/image";
import { Container } from "./container";
import { SiteLink } from "./site-link";
import { fullAddress, site } from "@/lib/site/content";

export function SiteFooter() {
  return (
    <footer>
      <Container className="flex flex-col gap-8 py-14 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Image src="/brand/logo-on-dark.png" alt={site.name} width={165} height={64} className="h-16 w-auto" />
          <p className="mt-5 text-lg text-muted">{fullAddress}</p>
          <nav aria-label="Pages" className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-lg">
            <SiteLink href="/functions" className="rounded-sm py-1 text-chalk underline decoration-line underline-offset-4 hover:decoration-brand">
              {site.functions.navLabel}
            </SiteLink>
            <SiteLink href="/contact" className="rounded-sm py-1 text-chalk underline decoration-line underline-offset-4 hover:decoration-brand">
              {site.contact.navLabel}
            </SiteLink>
          </nav>
        </div>
        <a
          href={site.staffSignInUrl}
          rel="nofollow"
          className="self-start rounded-sm py-2 text-base text-muted underline decoration-line underline-offset-4 hover:text-chalk sm:self-auto"
        >
          Staff sign-in
        </a>
      </Container>
    </footer>
  );
}
