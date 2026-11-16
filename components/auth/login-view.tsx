"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PinDots, PinPad } from "@/components/pin-pad";
import { Button, Notice, Spinner } from "@/components/ui";
import { api } from "@/lib/client/api";
import { errorMessage } from "@/lib/client/errors";

interface StaffItem {
  id: string;
  name: string;
  role: "staff" | "manager";
}

export function LoginView() {
  const router = useRouter();
  const [device, setDevice] = useState<{ id: string; label: string } | null>(null);
  const [staff, setStaff] = useState<StaffItem[] | null>(null);
  const [selected, setSelected] = useState<StaffItem | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const d = await api.device();
        if (cancelled) return;
        if (!d.device) {
          router.replace("/enrol");
          return;
        }
        setDevice(d.device);
        const list = await api.staffList();
        if (!cancelled) setStaff(list.staff);
      } catch (e) {
        if (!cancelled) setLoadError(errorMessage(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const submit = async () => {
    if (!selected || pin.length < 4 || pending) return;
    setPending(true);
    setError(null);
    try {
      await api.login(selected.id, pin);
      router.replace("/");
    } catch (e) {
      setError(errorMessage(e));
      setPin("");
      setPending(false);
    }
  };

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-6">
      <div className="text-center">
        <p aria-hidden className="text-5xl">
          🎱
        </p>
        <h1 className="mt-2 text-3xl font-bold">8 Ball Timer</h1>
        <p className="mt-1 text-lg text-muted">{device ? device.label : " "}</p>
      </div>

      {loadError ? (
        <div className="flex w-full max-w-md flex-col gap-3">
          <Notice tone="danger">{loadError}</Notice>
          <Button size="lg" onClick={() => window.location.reload()}>
            Try again
          </Button>
        </div>
      ) : !staff ? (
        <Spinner label="Loading staff" />
      ) : !selected ? (
        <section aria-label="Choose your name" className="w-full">
          <h2 className="mb-3 text-center text-xl font-semibold">Who&apos;s working?</h2>
          {staff.length === 0 ? (
            <Notice tone="warn">No staff accounts yet. Ask a manager to add you.</Notice>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {staff.map((s) => (
                <li key={s.id}>
                  <Button
                    size="lg"
                    full
                    className="min-h-20 flex-col gap-0"
                    onClick={() => {
                      setSelected(s);
                      setPin("");
                      setError(null);
                    }}
                  >
                    <span className="text-xl">{s.name}</span>
                    {s.role === "manager" ? <span className="text-sm font-medium text-brass">Manager</span> : null}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <section aria-label="Enter PIN" className="flex w-full max-w-sm flex-col gap-5">
          <div className="text-center">
            <h2 className="text-2xl font-semibold">{selected.name}</h2>
            <p className="text-muted">Enter your PIN</p>
          </div>
          <PinDots value={pin} />
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <PinPad compact value={pin} onChange={setPin} onSubmit={() => void submit()} disabled={pending} />
          <Button
            onClick={() => {
              setSelected(null);
              setPin("");
              setError(null);
            }}
            disabled={pending}
          >
            Not {selected.name}? Back
          </Button>
        </section>
      )}
    </div>
  );
}
