import { Expect } from "@/components/site/expect";
import { Faq } from "@/components/site/faq";
import { FindUs } from "@/components/site/find-us";
import { Hero } from "@/components/site/hero";
import { JsonLd } from "@/components/site/json-ld";
import { Pricing } from "@/components/site/pricing";

export default function SitePage() {
  return (
    <>
      <Hero />
      <Pricing />
      <Expect />
      <FindUs />
      <Faq />
      <JsonLd />
    </>
  );
}
