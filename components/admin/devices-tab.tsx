"use client";

import { useState } from "react";
import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { AdminDeviceDTO } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/format";
import { ActiveTag, RowActions, RowCard, TabHeader, type TabProps } from "./shared";

export function DevicesTab({ state, reload, onError }: TabProps) {
  const [revoking, setRevoking] = useState<AdminDeviceDTO | null>(null);
  const tz = state.settings.timezone;
  return (
    <div className="flex flex-col gap-4">
      <TabHeader title="Devices" />
      <ul className="flex flex-col gap-3">
        {state.devices.map((d) => (
          <RowCard key={d.id}>
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold">{d.label}</span>
                <ActiveTag active={!d.revokedAt} />
              </div>
              <p className="text-sm text-muted tabular-nums">
                Enrolled {formatDateTime(d.enrolledAt, tz)} · Last seen {d.lastSeenAt ? formatDateTime(d.lastSeenAt, tz) : "never"}
                {d.revokedAt ? ` · Revoked ${formatDateTime(d.revokedAt, tz)}` : ""}
              </p>
            </div>
            {!d.revokedAt ? (
              <RowActions>
                <Button variant="danger" onClick={() => setRevoking(d)}>
                  Revoke
                </Button>
              </RowActions>
            ) : null}
          </RowCard>
        ))}
      </ul>
      {revoking ? (
        <ActionDialog
          title={`Revoke ${revoking.label}`}
          description="That iPad will have to be enrolled again with a new code."
          submitLabel="Revoke"
          danger
          onClose={() => setRevoking(null)}
          onError={onError}
          onSubmit={async ({ reason }) => {
            await api.adminRevokeDevice(revoking.id, reason);
            await reload();
          }}
        />
      ) : null}
    </div>
  );
}
