import { Container } from "./container";
import { EnquiryForm } from "./enquiry-form";
import { hoursLine, site } from "@/lib/site/content";

/** The /functions page: a line or two, the room in brief, then the enquiry form (lands in Admin → Enquiries). */
export function Functions() {
  const facts = [
    `${site.tableCount} tables`,
    hoursLine ? hoursLine.replace(/\.$/, "") : null,
    `${site.address.unitAndStreet}, ${site.address.suburb}`,
  ].filter((f): f is string => f !== null);

  return (
    <section aria-labelledby="functions-heading">
      <Container className="grid gap-12 pb-20 pt-8 sm:pb-28 sm:pt-14 lg:grid-cols-[1fr_1.3fr] lg:gap-16">
        <div>
          <h1 id="functions-heading" className="display text-[clamp(3rem,11vw,7rem)] text-chalk">
            {site.functions.heading}
          </h1>
          <div className="chalk-rule mt-7" />
          <p className="mt-7 max-w-md text-xl leading-relaxed text-muted sm:text-2xl sm:leading-relaxed">{site.functions.lead}</p>
          <ul className="mt-10 space-y-3 text-xl text-accent">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
        <EnquiryForm kind="functions" />
      </Container>
    </section>
  );
}
