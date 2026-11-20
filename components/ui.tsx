"use client";

import Image from "next/image";
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "danger" | "ghost" | "accent";
type Size = "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand text-on-brand active:bg-brand-dark",
  accent: "bg-accent text-[#1a1305] active:bg-[#d8c7ae]",
  secondary: "border border-line bg-surface-2 text-chalk active:bg-line",
  danger: "bg-danger text-white active:bg-[#a0352d]",
  ghost: "text-chalk active:bg-surface-2",
};
const SIZE: Record<Size, string> = {
  md: "min-h-12 px-4 text-base",
  lg: "min-h-14 px-5 text-lg",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  full?: boolean;
}

export function Button({ variant = "secondary", size = "md", full, className = "", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex select-none items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${VARIANT[variant]} ${SIZE[size]} ${full ? "w-full" : ""} ${className}`}
      {...rest}
    />
  );
}

// ---------------------------------------------------------------------------
// Sheet (modal)
// ---------------------------------------------------------------------------

let scrollLocks = 0;

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Sits above another sheet (confirmations). */
  raised?: boolean;
  size?: "md" | "lg";
  /** Disable backdrop/Esc dismissal (e.g. while submitting). */
  locked?: boolean;
}

export function Sheet({ title, onClose, children, raised, size = "md", locked }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const lockedRef = useRef(locked);
  useEffect(() => {
    onCloseRef.current = onClose;
    lockedRef.current = locked;
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    scrollLocks += 1;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockedRef.current) {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      scrollLocks -= 1;
      if (scrollLocks <= 0) document.body.style.overflow = "";
      previous?.focus?.();
    };
  }, []);

  const width = size === "lg" ? "max-w-3xl" : "max-w-xl";
  return (
    <div
      className={`fixed inset-0 flex items-end justify-center bg-black/75 sm:items-center sm:p-6 ${raised ? "z-50" : "z-40"}`}
      onClick={(e) => {
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`sheet-in flex max-h-[94dvh] w-full ${width} flex-col overflow-hidden rounded-t-3xl border border-line bg-surface shadow-2xl outline-none sm:rounded-3xl`}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-xl font-semibold">{title}</h2>
          <Button variant="ghost" onClick={onClose} disabled={locked} aria-label="Close" className="-mr-2 w-12">
            <span aria-hidden className="text-2xl leading-none">
              ×
            </span>
          </Button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-5 py-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)]">
          {children}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export type Tone = "free" | "running" | "paused" | "awaiting" | "paid" | "void" | "neutral";

const TONE: Record<Tone, string> = {
  free: "bg-[#262626] text-chalk border-[#444444]",
  running: "bg-[#1b6845] text-[#eafff3] border-[#2f9265]",
  paused: "bg-[#1f4d7a] text-[#e4f2ff] border-[#3a77b0]",
  awaiting: "bg-[#8a5f12] text-[#fff3d6] border-[#c18a22]",
  paid: "bg-[#244a38] text-[#d6f3e3] border-[#3c7a5c]",
  void: "bg-[#4a2220] text-[#ffd9d4] border-[#8a403a]",
  neutral: "bg-surface-2 text-chalk border-line",
};

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-3 py-1 text-sm font-bold uppercase tracking-wide ${TONE[tone]}`}
    >
      {children}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
  strong,
}: {
  tone?: "info" | "warn" | "danger" | "success";
  children: ReactNode;
  strong?: boolean;
}) {
  const cls = {
    info: "border-[#3a77b0] bg-[#12263a]",
    warn: "border-[#c18a22] bg-[#33260a]",
    danger: "border-danger bg-[#3a1815]",
    success: "border-success bg-[#14301f]",
  }[tone];
  return (
    <div
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-3 ${strong ? "text-lg font-semibold" : "text-base"} ${cls}`}
    >
      {children}
    </div>
  );
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-10 text-muted">
      <span aria-hidden className="size-5 animate-spin rounded-full border-2 border-muted border-t-transparent" />
      <span>{label}…</span>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-muted">{label}</span>
      {children}
      {hint ? <span className="text-sm text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "min-h-12 w-full rounded-xl border border-line bg-bg px-3 text-base text-chalk placeholder:text-[#77716a] disabled:opacity-50";

export function Money({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`tabular-nums ${className}`}>{children}</span>;
}

/**
 * The venue's mark: the 8 ball from its logo on an orange disc, as on the app icon.
 * Decorative; the name next to it carries the meaning.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  const ball = Math.round(size * 0.84);
  return (
    <span aria-hidden className="flex shrink-0 items-center justify-center rounded-full bg-brand" style={{ width: size, height: size }}>
      <Image src="/brand/ball.png" alt="" width={ball} height={ball} />
    </span>
  );
}

/** The venue's full logo (ball and name), in the version cut for dark backgrounds. `height` in px. */
export function BrandLogo({ height = 96, priority = false }: { height?: number; priority?: boolean }) {
  // The file is 1400 × 544.
  const width = Math.round((height * 1400) / 544);
  return <Image src="/brand/logo-on-dark.png" alt="8 Ball Lounge" width={width} height={height} priority={priority} className="h-auto max-w-full" />;
}
