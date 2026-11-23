import { Faq } from "@/components/site/faq";
import { FindUs } from "@/components/site/find-us";
import { Gallery } from "@/components/site/gallery";
import { Hero } from "@/components/site/hero";
import { JsonLd } from "@/components/site/json-ld";
import { Price } from "@/components/site/price";
import { Tables } from "@/components/site/tables";

export default function SitePage() {
  return (
    <>
      <Hero />
      <Price />
      <Tables />
      <Gallery />
      <FindUs />
      <Faq />
      <JsonLd />
    </>
  );
}
