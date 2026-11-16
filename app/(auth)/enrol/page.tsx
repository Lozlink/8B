import type { Metadata } from "next";
import { EnrolView } from "@/components/auth/enrol-view";

export const metadata: Metadata = { title: "Set up this iPad" };

export default function EnrolPage() {
  return <EnrolView />;
}
