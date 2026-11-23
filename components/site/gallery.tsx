import Image from "next/image";
import { Container } from "./container";
import { site } from "@/lib/site/content";

/** Photos of the room. Nothing at all is rendered until `site.photos` has something in it. */
export function Gallery() {
  const photos = site.photos?.slice(0, 7) ?? [];
  if (photos.length === 0) return null;
  const [lead, ...rest] = photos;
  return (
    <section id="look" aria-labelledby="look-heading" className="scroll-mt-20">
      <Container className="pt-20 sm:pt-28">
        <h2 id="look-heading" className="display text-[clamp(2.75rem,8vw,5rem)] text-chalk">
          Have a look.
        </h2>
        <div className="mt-9 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <div className="relative col-span-2 aspect-[3/2] overflow-hidden rounded-3xl bg-surface lg:col-span-3 lg:aspect-[21/9]">
            <Image src={lead.src} alt={lead.alt} fill sizes="(min-width: 1152px) 1088px, 100vw" className="object-cover" />
          </div>
          {rest.map((p) => (
            <div key={p.src} className="relative aspect-square overflow-hidden rounded-3xl bg-surface">
              <Image src={p.src} alt={p.alt} fill sizes="(min-width: 1024px) 352px, 50vw" className="object-cover" />
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
