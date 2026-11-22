import { Suspense } from "react";
import type { Metadata } from "next";
import { EndOfDayView } from "@/components/end-of-day/end-of-day-view";
import { Spinner } from "@/components/ui";

export const metadata: Metadata = { title: "End of day" };

export default function EndOfDayPage() {
  // The view reads ?date= on the client, so it has to sit inside Suspense.
  return (
    <Suspense fallback={<Spinner />}>
      <EndOfDayView />
    </Suspense>
  );
}
