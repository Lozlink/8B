"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/toast";
import { Button, Sheet } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { useAction } from "@/lib/client/use-action";
import { itemCents } from "@/lib/domain/bill";
import { can, isCheckoutLive } from "@/lib/domain/machine";
import type { SessionDTO, SessionItemDTO } from "@/lib/domain/types";
import { formatTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

interface Props {
  session: SessionDTO;
  /** Reloads the open sheet's detail. The floor is refetched here as well. */
  reload: () => Promise<void>;
}

/** Add and remove snacks/drinks on a bill. Shared by the session detail sheet and the charge sheet. */
export function ItemsPanel({ session, reload }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { floor, offline, refetch } = useFloor();
  const { run, pending: removing } = useAction();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const [toRemove, setToRemove] = useState<SessionItemDTO | null>(null);

  const products = floor?.products ?? [];
  const items = session.items;
  const tz = floor?.pricing.settings.timezone ?? "Australia/Sydney";
  const editable = can(session.status, "add_item");
  const cardLive = session.status === "awaiting_payment" && isCheckoutLive(session.checkout?.status);
  const blocked = cardLive ? "Cancel the card request before changing the bill." : offline ? "No connection. Wait for it to come back before changing the bill." : null;

  if (products.length === 0 && items.length === 0 && !editable) return null;

  const add = async (productId: string) => {
    if (inflight.current.has(productId)) return;
    inflight.current.add(productId);
    setAdding(new Set(inflight.current));
    try {
      await api.addItem(session.id, productId, 1);
      await Promise.all([reload(), refetch()]);
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) {
        router.replace(dest);
      } else {
        toast.show(errorMessage(e), "error");
        // The bill may have moved under us (another iPad, or a card request started): resync.
        if (e instanceof ApiError && e.status === 409) await Promise.all([reload(), refetch()]);
      }
    } finally {
      inflight.current.delete(productId);
      setAdding(new Set(inflight.current));
    }
  };

  const confirmRemove = async () => {
    if (!toRemove) return;
    const done = await run(async () => {
      await api.removeItem(session.id, toRemove.id);
      await reload();
      return true as const;
    });
    if (done) {
      toast.show(`${toRemove.name} taken off`, "success");
      setToRemove(null);
    }
  };

  return (
    <section aria-label="Items" className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">Items</h3>

      {editable ? (
        products.length === 0 ? (
          items.length === 0 ? (
            <p className="text-muted">No items to add yet. A manager can load them under Admin → Items.</p>
          ) : null
        ) : (
          <>
            {blocked ? <p className="text-warn">{blocked}</p> : null}
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {products.map((p) => (
                <li key={p.id} className="flex">
                  <button
                    type="button"
                    disabled={!!blocked || adding.has(p.id)}
                    aria-busy={adding.has(p.id)}
                    aria-label={`Add ${p.name}, ${formatCents(p.priceCents)}${p.taxed ? "" : ", GST-free"}`}
                    onClick={() => void add(p.id)}
                    className="flex min-h-20 w-full select-none flex-col items-start justify-between gap-1 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left transition-colors active:bg-line disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <span className="line-clamp-2 text-base font-semibold leading-snug">{p.name}</span>
                    <span className="flex flex-wrap items-baseline gap-x-2 text-base tabular-nums text-muted">
                      {adding.has(p.id) ? "Adding…" : formatCents(p.priceCents)}
                      {!adding.has(p.id) && !p.taxed ? <span className="text-sm">GST-free</span> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}

      {items.length > 0 ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {i.quantity} × {i.name}
                  {!i.taxed ? <span className="ml-2 text-sm font-normal text-muted">GST-free</span> : null}
                </p>
                <p className="text-sm text-muted">
                  Added by {i.addedByName} at {formatTime(i.addedAt, tz)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="tabular-nums">{formatCents(itemCents(i))}</span>
                {editable ? (
                  <Button
                    disabled={!!blocked || removing}
                    aria-label={`Remove ${i.name}, ${formatCents(itemCents(i))}`}
                    onClick={() => setToRemove(i)}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : editable && products.length > 0 ? (
        <p className="text-muted">Nothing added yet.</p>
      ) : null}

      {toRemove ? (
        <Sheet title="Take this off the bill?" onClose={() => setToRemove(null)} raised locked={removing}>
          <div className="flex flex-col gap-5">
            <p className="text-lg">
              {toRemove.quantity} × {toRemove.name} <span className="tabular-nums text-muted">· {formatCents(itemCents(toRemove))}</span>
            </p>
            <p className="text-muted">It stays on record as removed.</p>
            <div className="grid grid-cols-2 gap-3">
              <Button size="lg" onClick={() => setToRemove(null)} disabled={removing}>
                Keep it
              </Button>
              <Button size="lg" variant="danger" disabled={removing || !!blocked} onClick={() => void confirmRemove()}>
                {removing ? "Removing…" : "Remove"}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </section>
  );
}
