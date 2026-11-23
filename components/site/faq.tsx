import { Container } from "./container";
import { faqItems, site } from "@/lib/site/content";

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-20 bg-surface">
      <Container className="grid gap-10 py-20 sm:py-24 lg:grid-cols-[1fr_1.7fr] lg:gap-16">
        <h2 id="faq-heading" className="display text-[clamp(2.5rem,7vw,4.25rem)] text-chalk">
          {site.faqHeading}
        </h2>
        <div>
          {faqItems.map((f, i) => (
            <details key={f.question} open={i === 0} className="border-b border-line">
              <summary className="flex min-h-16 items-center justify-between gap-6 py-4 text-xl font-semibold text-chalk">
                {f.question}
                <span aria-hidden="true" className="faq-mark text-3xl font-normal leading-none text-brand transition-[rotate] duration-150">
                  +
                </span>
              </summary>
              <p className="max-w-xl pb-6 text-lg leading-relaxed text-muted">{f.answer}</p>
            </details>
          ))}
        </div>
      </Container>
    </section>
  );
}
