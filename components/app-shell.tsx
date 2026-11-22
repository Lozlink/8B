"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore, type ReactNode } from "react";
import { BrandMark, Button } from "@/components/ui";
import { api } from "@/lib/client/api";
import { FloorProvider, useFloor } from "@/lib/client/floor-context";
import { useAction } from "@/lib/client/use-action";
import { APP_ORIGIN, isSiteHost } from "@/lib/site/routing";

const NAV = [
  { href: "/", label: "Floor" },
  { href: "/unpaid", label: "Unpaid" },
  { href: "/summary", label: "Summary" },
  { href: "/admin", label: "Admin" },
] as const;

function OfflineOverlay() {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="offline-title"
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-4 bg-black/95 px-8 text-center"
    >
      <p aria-hidden className="text-6xl">
        ⚠
      </p>
      <h2 id="offline-title" className="text-3xl font-bold text-warn">
        Offline — write start times on the paper sheet
      </h2>
      <p className="max-w-lg text-lg text-muted">
        Can&apos;t reach the server. This screen will come back by itself as soon as it responds. Nothing you tap now is saved.
      </p>
    </div>
  );
}

function DegradedBanner() {
  return (
    <div role="status" className="border-b border-[#c18a22] bg-[#33260a] px-4 py-2 text-center text-base">
      Having trouble reaching the server. Trying again. What you see may be a few seconds behind.
    </div>
  );
}

const never = () => () => {};

/**
 * Shown on an iPad still using the app at the old address (the public site's host). It keeps
 * working there for now; this says where it lives and how to move.
 */
function MovedBanner() {
  // The address is only known in the browser, and it never changes while the page is open.
  const onOldHost = useSyncExternalStore(never, () => isSiteHost(window.location.host), () => false);
  if (!onOldHost) return null;
  return (
    <div role="status" className="border-b border-line bg-surface-2 px-4 py-2 text-center text-base print:hidden">
      This app has moved to <strong className="font-semibold">{APP_ORIGIN.replace("https://", "")}</strong>. Open that address in
      Safari, add it to the Home Screen and enrol this iPad there. A manager has the code.
    </div>
  );
}

function Chrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me, unpaidCount, offline, degraded } = useFloor();
  const { run, pending } = useAction();

  const switchUser = () =>
    void run(
      async () => {
        await api.logout();
        // Full load: drops every hidden page and its state along with the session (see LoginView).
        window.location.replace("/login");
      },
      { refetch: false },
    );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur print:hidden">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <BrandMark size={32} />
            <div className="min-w-0 leading-tight">
              <p className="truncate text-base font-bold">{me?.device.label ?? "…"}</p>
              <p className="truncate text-sm text-muted">{me ? me.staff.name : "Signing in…"}</p>
            </div>
          </div>

          <nav aria-label="Main" className="order-3 flex w-full gap-2 sm:order-none sm:w-auto sm:flex-1 sm:justify-center">
            {NAV.map((item) => {
              const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-base font-semibold sm:flex-none ${
                    active ? "bg-brand text-on-brand" : "bg-surface-2 text-chalk active:bg-line"
                  }`}
                >
                  {item.label}
                  {item.href === "/unpaid" && unpaidCount > 0 ? (
                    <span
                      className="inline-flex min-w-7 items-center justify-center rounded-full bg-accent px-2 py-0.5 text-sm font-bold tabular-nums text-[#1a1305]"
                      aria-label={`${unpaidCount} unpaid`}
                    >
                      {unpaidCount}
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </nav>

          <Button className="ml-auto" onClick={switchUser} disabled={pending}>
            Switch user
          </Button>
        </div>
      </header>
      <MovedBanner />
      {degraded && !offline ? <DegradedBanner /> : null}
      <main className="flex-1 px-4 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]">{children}</main>
      {offline ? <OfflineOverlay /> : null}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <FloorProvider>
      <Chrome>{children}</Chrome>
    </FloorProvider>
  );
}
