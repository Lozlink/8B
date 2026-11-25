import Image from "next/image";
import { Container } from "./container";
import { site } from "@/lib/site/content";

/**
 * Photos of the room. Nothing at all is rendered until `site.photos` has something in it.
 * The first is the lead: full width. The rest sit under it, three across from tablet width up
 * and one per row on a phone. Photos keep their own shape (they're 4:3 off a phone) everywhere
 * except the lead on a wide screen, which is trimmed to 16:9 so it doesn't fill the whole view.
 */
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
        <figure className="relative mt-9 aspect-[4/3] overflow-hidden rounded-3xl bg-surface sm:aspect-[16/9]">
          <Image
            src={lead.src}
            alt={lead.alt}
            fill
            sizes="(min-width: 1152px) 1088px, (min-width: 640px) calc(100vw - 64px), calc(100vw - 40px)"
            className="object-cover"
          />
        </figure>
        {rest.length > 0 ? (
          <ul className="mt-3 grid grid-cols-1 gap-3 sm:mt-4 sm:grid-cols-3 sm:gap-4">
            {rest.map((p) => (
              <li key={p.src} className="relative aspect-[4/3] overflow-hidden rounded-3xl bg-surface">
                <Image
                  src={p.src}
                  alt={p.alt}
                  fill
                  sizes="(min-width: 1152px) 352px, (min-width: 640px) calc((100vw - 96px) / 3), calc(100vw - 40px)"
                  className="object-cover"
                />
              </li>
            ))}
          </ul>
        ) : null}
      </Container>
    </section>
  );
}
