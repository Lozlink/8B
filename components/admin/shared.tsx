"use client";

import type { ReactNode } from "react";
import type { AdminStateDTO } from "@/lib/domain/types";

export interface TabProps {
  state: AdminStateDTO;
  reload: () => Promise<void>;
  /** Pass to ActionDialog.onError so an expired elevation re-prompts for the PIN. */
  onError: (e: unknown) => boolean;
}

export function TabHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-semibold">{title}</h2>
      {action}
    </div>
  );
}

export function RowCard({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </li>
  );
}

export function RowActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-2">{children}</div>;
}

export function ActiveTag({ active }: { active: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-0.5 text-sm font-semibold ${
        active ? "border-[#3c7a5c] bg-[#244a38] text-[#d6f3e3]" : "border-line bg-surface-2 text-muted"
      }`}
    >
      {active ? "Active" : "Inactive"}
    </span>
  );
}

export const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
