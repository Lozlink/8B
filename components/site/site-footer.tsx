import Image from "next/image";
import { Container } from "./container";
import { fullAddress, site } from "@/lib/site/content";

export function SiteFooter() {
  return (
    <footer className="border-t border-line">
      <Container className="flex flex-col gap-8 py-12 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <Image src="/brand/logo-on-dark.png" alt="" width={104} height={40} className="h-10 w-auto" />
          <p className="mt-5 text-base font-semibold text-chalk">{site.name}</p>
          <p className="mt-1 text-base text-muted">{fullAddress}</p>
        </div>
        <a
          href={site.staffSignInUrl}
          rel="nofollow"
          className="self-start rounded-sm py-2 text-sm text-muted underline decoration-line underline-offset-4 hover:text-chalk sm:self-auto"
        >
          Staff sign-in
        </a>
      </Container>
    </footer>
  );
}
