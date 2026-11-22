import Link from "next/link";
import { Container } from "@/components/site/container";
import { SiteFooter } from "@/components/site/site-footer";
import { site } from "@/lib/site/content";

export default function SiteNotFound() {
  return (
    <>
      <main id="main" className="flex-1">
        <Container className="py-28 sm:py-40">
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-brand">404</p>
          <h1 className="mt-4 text-4xl font-black tracking-tight sm:text-6xl">That page is not here</h1>
          <p className="mt-5 max-w-md text-lg text-muted">The link may be old or mistyped. The whole of {site.name} is on one page.</p>
          <Link
            href="/"
            className="mt-9 inline-flex min-h-12 items-center rounded-lg bg-brand px-6 text-base font-bold text-on-brand transition-colors hover:bg-brand-dark"
          >
            Go to the home page
          </Link>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
