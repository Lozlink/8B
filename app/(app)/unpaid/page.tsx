import type { Metadata } from "next";
import { UnpaidView } from "@/components/unpaid-view";

export const metadata: Metadata = { title: "Unpaid" };

export default function UnpaidPage() {
  return <UnpaidView />;
}
