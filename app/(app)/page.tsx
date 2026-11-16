import type { Metadata } from "next";
import { FloorView } from "@/components/floor/floor-view";

export const metadata: Metadata = { title: "Floor" };

export default function FloorPage() {
  return <FloorView />;
}
