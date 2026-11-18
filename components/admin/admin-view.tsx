"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { PinDots, PinPad } from "@/components/pin-pad";
import { useToast } from "@/components/toast";
import { Button, Notice, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { useLoad } from "@/lib/client/use-load";
import { authRedirect, errorMessage, isManagerRequired } from "@/lib/client/errors";
import type { AdminStateDTO } from "@/lib/domain/types";
import { AuditTab } from "./audit-tab";
import { DevicesTab } from "./devices-tab";
import { ItemsTab } from "./items-tab";
import { RatesTab } from "./rates-tab";
import { SettingsTab } from "./settings-tab";
import { StaffTab } from "./staff-tab";
import { TablesTab } from "./tables-tab";
import { TerminalTab } from "./terminal-tab";

const TABS = [
  { id: "tables", label: "Tables" },
  { id: "rates", label: "Rate cards" },
  { id: "items", label: "Items" },
  { id: "settings", label: "Settings" },
  { id: "staff", label: "Staff" },
  { id: "devices", label: "Devices" },
  { id: "terminal", label: "Terminal" },
  { id: "audit", label: "Audit log" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type Phase = { kind: "checking" } | { kind: "locked" } | { kind: "ready"; state: AdminStateDTO };

export function AdminView() {
  const router = useRouter();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const [tab, setTab] = useState<TabId>("tables");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await api.adminState();
      setPhase({ kind: "ready", state });
      setLoadError(null);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else if (isManagerRequired(e)) setPhase({ kind: "locked" });
      else setLoadError(errorMessage(e));
    }
  }, [router]);

  useLoad(load);

  /** Elevation expired mid-edit: ask for the PIN again. Returns true when handled. */
  const onError = useCallback(
    (e: unknown) => {
      if (isManagerRequired(e)) {
        setPhase({ kind: "locked" });
        toast.show("Manager PIN needed again.", "info");
        return true;
      }
      return false;
    },
    [toast],
  );

  if (phase.kind === "checking") {
    return loadError ? (
      <div className="mx-auto flex max-w-md flex-col gap-3">
        <Notice tone="danger">{loadError}</Notice>
        <Button size="lg" onClick={() => void load()}>
          Try again
        </Button>
      </div>
    ) : (
      <Spinner />
    );
  }

  if (phase.kind === "locked") return <Gate onUnlocked={load} loadError={loadError} />;

  const tabProps = { state: phase.state, reload: load, onError };

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Admin</h1>
        <div className="flex items-center gap-3">
          <span className="text-muted">Approved by {phase.state.manager.name}</span>
          <Button
            onClick={() => {
              void api.adminDrop().catch(() => undefined);
              setPhase({ kind: "locked" });
            }}
          >
            Lock
          </Button>
        </div>
      </div>

      <div role="tablist" aria-label="Admin sections" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="admin-panel"
            onClick={() => setTab(t.id)}
            className={`min-h-12 shrink-0 rounded-xl px-4 text-base font-semibold ${
              tab === t.id ? "bg-brand text-on-brand" : "bg-surface-2 text-chalk active:bg-line"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div id="admin-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {tab === "tables" ? <TablesTab {...tabProps} /> : null}
        {tab === "rates" ? <RatesTab {...tabProps} /> : null}
        {tab === "items" ? <ItemsTab {...tabProps} /> : null}
        {tab === "settings" ? <SettingsTab {...tabProps} /> : null}
        {tab === "staff" ? <StaffTab {...tabProps} /> : null}
        {tab === "devices" ? <DevicesTab {...tabProps} /> : null}
        {tab === "terminal" ? <TerminalTab {...tabProps} /> : null}
        {tab === "audit" ? <AuditTab {...tabProps} /> : null}
      </div>
    </div>
  );
}

function Gate({ onUnlocked, loadError }: { onUnlocked: () => Promise<void>; loadError: string | null }) {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pin.length < 4 || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.adminElevate(pin);
      await onUnlocked();
      setPin("");
      setPending(false);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) router.replace(dest);
      else setError(errorMessage(e));
      setPin("");
      setPending(false);
    }
  };

  return (
    <section aria-label="Manager PIN" className="mx-auto flex w-full max-w-sm flex-col gap-5 py-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">Manager PIN</h1>
        <p className="text-muted">Admin stays unlocked for 10 minutes.</p>
      </div>
      <PinDots value={pin} />
      {error ?? loadError ? <Notice tone="danger">{error ?? loadError}</Notice> : null}
      <PinPad compact value={pin} onChange={setPin} onSubmit={() => void submit()} disabled={pending} />
    </section>
  );
}
