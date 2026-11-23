import Image from "next/image";
import { Container } from "./container";
import { fullAddress, site } from "@/lib/site/content";

export function SiteFooter() {
  return (
    <footer>
      <Container className="flex flex-col gap-8 py-14 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Image src="/brand/logo-on-dark.png" alt={site.name} width={165} height={64} className="h-16 w-auto" />
          <p className="mt-5 text-lg text-muted">{fullAddress}</p>
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
