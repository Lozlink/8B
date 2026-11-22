import { Container } from "./container";
import { faqItems, site } from "@/lib/site/content";

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-heading" className="scroll-mt-16 border-t border-line bg-surface">
      <Container className="grid gap-10 py-20 sm:py-28 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
        <h2 id="faq-heading" className="text-3xl font-bold tracking-tight sm:text-4xl">
          {site.faqHeading}
        </h2>
        <div className="divide-y divide-line border-y border-line">
          {faqItems.map((f) => (
            <div key={f.question} className="py-6">
              <h3 className="text-lg font-semibold text-chalk">{f.question}</h3>
              <p className="mt-2 text-base leading-relaxed text-muted">{f.answer}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
