"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button, Field, inputClass } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { AdminStaffDTO, StaffRole } from "@/lib/domain/types";
import { ActiveTag, RowActions, RowCard, TabHeader, type TabProps } from "./shared";

type Dialog =
  | { kind: "add" }
  | { kind: "rename"; member: AdminStaffDTO }
  | { kind: "role"; member: AdminStaffDTO }
  | { kind: "pin"; member: AdminStaffDTO }
  | { kind: "active"; member: AdminStaffDTO }
  | null;

const PIN_RE = /^\d{4,6}$/;

export function StaffTab({ state, reload, onError }: TabProps) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);

  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Staff" action={<Button variant="primary" onClick={() => setDialog({ kind: "add" })}>Add staff</Button>} />
      <ul className="flex flex-col gap-3">
        {state.staff.map((m) => (
          <RowCard key={m.id}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-lg font-semibold">{m.name}</span>
              <span className="rounded-full border border-line bg-surface-2 px-2.5 py-0.5 text-sm font-semibold capitalize">{m.role}</span>
              <ActiveTag active={m.active} />
            </div>
            <RowActions>
              <Button onClick={() => setDialog({ kind: "rename", member: m })}>Rename</Button>
              <Button onClick={() => setDialog({ kind: "role", member: m })}>Change role</Button>
              <Button onClick={() => setDialog({ kind: "pin", member: m })}>Reset PIN</Button>
              <Button onClick={() => setDialog({ kind: "active", member: m })}>{m.active ? "Deactivate" : "Activate"}</Button>
            </RowActions>
          </RowCard>
        ))}
      </ul>

      {dialog?.kind === "add" ? <AddDialog reload={reload} onClose={close} onError={onError} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog member={dialog.member} reload={reload} onClose={close} onError={onError} /> : null}
      {dialog?.kind === "role" ? <RoleDialog member={dialog.member} reload={reload} onClose={close} onError={onError} /> : null}
      {dialog?.kind === "pin" ? <PinDialog member={dialog.member} reload={reload} onClose={close} onError={onError} /> : null}
      {dialog?.kind === "active" ? (
        <ActionDialog
          title={`${dialog.member.active ? "Deactivate" : "Activate"} ${dialog.member.name}`}
          description={dialog.member.active ? "They can no longer sign in. Their history stays." : "They can sign in again."}
          submitLabel={dialog.member.active ? "Deactivate" : "Activate"}
          danger={dialog.member.active}
          onClose={close}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.adminStaff({ op: "update", id: dialog.member.id, active: !dialog.member.active, reason });
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}

interface DialogProps {
  reload: () => Promise<void>;
  onClose: () => void;
  onError: (e: unknown) => boolean;
}

function RoleToggle({ value, onChange }: { value: StaffRole; onChange: (r: StaffRole) => void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-semibold text-muted">Role</legend>
      <div className="grid grid-cols-2 gap-2">
        {(["staff", "manager"] as const).map((r) => (
          <Button key={r} variant={value === r ? "primary" : "secondary"} aria-pressed={value === r} className="capitalize" onClick={() => onChange(r)}>
            {r}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

function PinFields({ pin1, pin2, setPin1, setPin2 }: { pin1: string; pin2: string; setPin1: (v: string) => void; setPin2: (v: string) => void }) {
  return (
    <>
      <Field label="PIN (4 to 6 digits)">
        <input className={inputClass} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin1} onChange={(e) => setPin1(e.target.value.replace(/\D/g, ""))} />
      </Field>
      <Field label="Repeat PIN" hint={pin2 && pin1 !== pin2 ? "PINs don't match." : undefined}>
        <input className={inputClass} type="password" inputMode="numeric" autoComplete="new-password" maxLength={6} value={pin2} onChange={(e) => setPin2(e.target.value.replace(/\D/g, ""))} />
      </Field>
    </>
  );
}

function AddDialog({ reload, onClose, onError }: DialogProps) {
  const [name, setName] = useState("");
  const [role, setRole] = useState<StaffRole>("staff");
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  return (
    <ActionDialog
      title="Add staff"
      submitLabel="Add"
      canSubmit={name.trim().length > 0 && PIN_RE.test(pin1) && pin1 === pin2}
      onClose={onClose}
      onError={onError}
      onSubmit={async ({ reason }) => {
        await api.adminStaff({ op: "create", name: name.trim(), role, pin: pin1, reason });
        await reload();
      }}
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </Field>
        <RoleToggle value={role} onChange={setRole} />
        <PinFields pin1={pin1} pin2={pin2} setPin1={setPin1} setPin2={setPin2} />
      </div>
    </ActionDialog>
  );
}

function RenameDialog({ member, reload, onClose, onError }: DialogProps & { member: AdminStaffDTO }) {
  const [name, setName] = useState(member.name);
  return (
    <ActionDialog
      title={`Rename ${member.name}`}
      submitLabel="Rename"
      canSubmit={name.trim().length > 0 && name.trim() !== member.name}
      onClose={onClose}
      onError={onError}
      onSubmit={async ({ reason }) => {
        await api.adminStaff({ op: "update", id: member.id, name: name.trim(), reason });
        await reload();
      }}
    >
      <Field label="Name">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </Field>
    </ActionDialog>
  );
}

function RoleDialog({ member, reload, onClose, onError }: DialogProps & { member: AdminStaffDTO }) {
  const [role, setRole] = useState<StaffRole>(member.role);
  return (
    <ActionDialog
      title={`Role for ${member.name}`}
      submitLabel="Change role"
      canSubmit={role !== member.role}
      onClose={onClose}
      onError={onError}
      onSubmit={async ({ reason }) => {
        await api.adminStaff({ op: "update", id: member.id, role, reason });
        await reload();
      }}
    >
      <RoleToggle value={role} onChange={setRole} />
    </ActionDialog>
  );
}

function PinDialog({ member, reload, onClose, onError }: DialogProps & { member: AdminStaffDTO }) {
  const [pin1, setPin1] = useState("");
  const [pin2, setPin2] = useState("");
  return (
    <ActionDialog
      title={`Reset PIN for ${member.name}`}
      submitLabel="Reset PIN"
      canSubmit={PIN_RE.test(pin1) && pin1 === pin2}
      onClose={onClose}
      onError={onError}
      onSubmit={async ({ reason }) => {
        await api.adminStaff({ op: "update", id: member.id, pin: pin1, reason });
        await reload();
      }}
    >
      <PinFields pin1={pin1} pin2={pin2} setPin1={setPin1} setPin2={setPin2} />
    </ActionDialog>
  );
}
