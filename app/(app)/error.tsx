"use client";

import { Button } from "@/components/ui";

export default function AppError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div role="alert" className="mx-auto flex max-w-lg flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-3xl font-bold">Something went wrong</h1>
      <p className="text-lg text-muted">
        This screen hit a problem. Reload to carry on. If it keeps happening, write start times on the paper sheet and tell a
        manager.
      </p>
      <div className="grid w-full grid-cols-2 gap-3">
        <Button size="lg" onClick={() => retry()}>
          Try again
        </Button>
        <Button size="lg" variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
