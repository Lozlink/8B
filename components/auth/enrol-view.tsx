"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandLogo, Button, Field, Notice, Spinner, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import { errorMessage } from "@/lib/client/errors";

const QUICK_LABELS = ["Counter", "Floor 1", "Floor 2"] as const;
const PIN_RE = /^\d{4,6}$/;

export function EnrolView() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState<string>("");
  const [mgrName, setMgrName] = useState("");
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .device()
      .then((d) => {
        if (cancelled) return;
        if (d.device) {
          router.replace("/login");
          return;
        }
        setSetupNeeded(d.setupNeeded);
        setReady(true);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [router, attempt]);

  const pinsOk = !setupNeeded || (PIN_RE.test(pin1) && pin1 === pin2 && mgrName.trim().length > 0);
  const canSubmit = code.trim().length > 0 && label.trim().length > 0 && pinsOk && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    setError(null);
    try {
      await api.enrol({
        code: code.trim(),
        label: label.trim(),
        ...(setupNeeded ? { firstManager: { name: mgrName.trim(), pin: pin1 } } : {}),
      });
      router.replace("/login");
    } catch (e) {
      const message = errorMessage(e);
      // The server says a first manager is needed: reveal those fields.
      if (/first manager/i.test(message)) setSetupNeeded(true);
      setError(message);
      setPending(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex w-full max-w-md flex-col gap-3">
        <Notice tone="danger">{loadError}</Notice>
        <Button
          size="lg"
          onClick={() => {
            setLoadError(null);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!ready) return <Spinner />;

  return (
    <form
      className="flex w-full max-w-lg flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-center">
        <div className="flex justify-center">
          <BrandLogo height={104} priority />
        </div>
        <h1 className="mt-4 text-3xl font-bold">Set up this iPad</h1>
        <p className="mt-1 text-muted">Ask a manager for the enrolment code.</p>
      </div>

      <Field label="Enrolment code">
        <input
          className={`${inputClass} text-xl tracking-widest`}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
        />
      </Field>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold text-muted">This iPad is</legend>
        <div className="grid grid-cols-3 gap-2">
          {QUICK_LABELS.map((l) => (
            <Button key={l} variant={label === l ? "primary" : "secondary"} aria-pressed={label === l} onClick={() => setLabel(l)}>
              {l}
            </Button>
          ))}
        </div>
        <input
          className={inputClass}
          placeholder="Or type a custom name"
          value={QUICK_LABELS.includes(label as (typeof QUICK_LABELS)[number]) ? "" : label}
          onChange={(e) => setLabel(e.target.value)}
          maxLength={30}
          aria-label="Custom device name"
        />
      </fieldset>

      {setupNeeded ? (
        <fieldset className="flex flex-col gap-3 rounded-2xl border border-line p-4">
          <legend className="px-2 text-base font-semibold text-accent">First manager</legend>
          <p className="text-sm text-muted">No manager exists yet. Create the first one now (PIN of 4 to 6 digits).</p>
          <Field label="Name">
            <input className={inputClass} value={mgrName} onChange={(e) => setMgrName(e.target.value)} maxLength={40} />
          </Field>
          <Field label="PIN">
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={pin1}
              onChange={(e) => setPin1(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Repeat PIN" hint={pin2 && pin1 !== pin2 ? "PINs don't match." : undefined}>
            <input
              className={inputClass}
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={6}
              value={pin2}
              onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))}
            />
          </Field>
        </fieldset>
      ) : null}

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Button type="submit" variant="primary" size="lg" disabled={!canSubmit}>
        {pending ? "Setting up…" : "Enrol this iPad"}
      </Button>
    </form>
  );
}
