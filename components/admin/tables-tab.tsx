"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { TableDTO } from "@/lib/domain/types";
import { ActiveTag, RowActions, RowCard, TabHeader, type TabProps } from "./shared";

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; table: TableDTO }
  | { kind: "toggle"; table: TableDTO }
  | { kind: "move"; table: TableDTO; dir: -1 | 1 }
  | null;

export function TablesTab({ state, reload, onError }: TabProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const tables = state.tables.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const close = () => setDialog(null);

  const move = async (table: TableDTO, dir: -1 | 1, reason: string) => {
    const idx = tables.findIndex((t) => t.id === table.id);
    const other = tables[idx + dir];
    if (!other) return;
    const strictlyIncreasing = tables.every((t, i) => i === 0 || t.sortOrder > tables[i - 1].sortOrder);
    if (strictlyIncreasing) {
      await api.adminTable({ op: "update", id: table.id, sortOrder: other.sortOrder, reason });
      await api.adminTable({ op: "update", id: other.id, sortOrder: table.sortOrder, reason });
    } else {
      // Sort orders collide: renumber to match the new on-screen order.
      const next = tables.slice();
      next[idx] = other;
      next[idx + dir] = table;
      for (const [i, t] of next.entries()) {
        if (t.sortOrder !== i + 1) await api.adminTable({ op: "update", id: t.id, sortOrder: i + 1, reason });
      }
    }
    await reload();
  };

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Tables" action={<Button variant="primary" onClick={() => setDialog({ kind: "add" })}>Add table</Button>} />
      <p className="text-sm text-muted">Tables are never deleted. Deactivate one to take it off the floor.</p>
      <ul className="flex flex-col gap-3">
        {tables.map((t, i) => (
          <RowCard key={t.id}>
            <div className="flex items-center gap-3">
              <span className="text-lg font-semibold">{t.name}</span>
              <ActiveTag active={t.active} />
            </div>
            <RowActions>
              <Button aria-label={`Move ${t.name} up`} disabled={i === 0} onClick={() => setDialog({ kind: "move", table: t, dir: -1 })}>
                ↑
              </Button>
              <Button aria-label={`Move ${t.name} down`} disabled={i === tables.length - 1} onClick={() => setDialog({ kind: "move", table: t, dir: 1 })}>
                ↓
              </Button>
              <Button onClick={() => setDialog({ kind: "rename", table: t })}>Rename</Button>
              <Button onClick={() => setDialog({ kind: "toggle", table: t })}>{t.active ? "Deactivate" : "Activate"}</Button>
            </RowActions>
          </RowCard>
        ))}
      </ul>

      {dialog?.kind === "add" ? <NameDialog title="Add table" submit="Add table" initial="" onClose={close} onError={onError} onSave={async (name, reason) => {
        await api.adminTable({ op: "create", name, reason });
        await reload();
      }} /> : null}

      {dialog?.kind === "rename" ? (
        <NameDialog
          title={`Rename ${dialog.table.name}`}
          submit="Rename"
          initial={dialog.table.name}
          onClose={close}
          onError={onError}
          onSave={async (name, reason) => {
            await api.adminTable({ op: "update", id: dialog.table.id, name, reason });
            await reload();
          }}
        />
      ) : null}

      {dialog?.kind === "toggle" ? (
        <ActionDialog
          title={`${dialog.table.active ? "Deactivate" : "Activate"} ${dialog.table.name}`}
          description={dialog.table.active ? "It disappears from the floor. History is kept." : "It returns to the floor."}
          submitLabel={dialog.table.active ? "Deactivate" : "Activate"}
          danger={dialog.table.active}
          onClose={close}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.adminTable({ op: "update", id: dialog.table.id, active: !dialog.table.active, reason });
            await reload();
          }}
        />
      ) : null}

      {dialog?.kind === "move" ? (
        <ActionDialog
          title={`Move ${dialog.table.name} ${dialog.dir < 0 ? "up" : "down"}`}
          submitLabel="Move"
          onClose={close}
          onError={onError}
          onSubmit={({ reason }) => move(dialog.table, dialog.dir, reason)}
        />
      ) : null}
    </div>
  );
}

function NameDialog({
  title,
  submit,
  initial,
  onSave,
  onClose,
  onError,
}: {
  title: string;
  submit: string;
  initial: string;
  onSave: (name: string, reason: string) => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => boolean;
}) {
  const [name, setName] = useState(initial);
  const trimmed = name.trim();
  return (
    <ActionDialog
      title={title}
      submitLabel={submit}
      canSubmit={trimmed.length > 0 && trimmed !== initial}
      onClose={onClose}
      onError={onError}
      onSubmit={({ reason }) => onSave(trimmed, reason)}
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
    </ActionDialog>
  );
}
