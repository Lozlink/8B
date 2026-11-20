"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import { CustomCharge } from "@/components/custom-charge";
import { useToast } from "@/components/toast";
import { Button, Sheet, inputClass } from "@/components/ui";
import { api, ApiError } from "@/lib/client/api";
import { billCan, lineLabel } from "@/lib/client/bill-view";
import { findByBarcode, normaliseBarcode } from "@/lib/client/barcode";
import { authRedirect, errorMessage } from "@/lib/client/errors";
import { useFloor } from "@/lib/client/floor-context";
import { ALL_CATEGORY, categoryOptions, filterProducts, itemSections, stockLabel } from "@/lib/client/item-picker";
import { getLastCategory, setLastCategory } from "@/lib/client/last-category";
import { useAction } from "@/lib/client/use-action";
import { useScanHandler } from "@/lib/client/use-scan-handler";
import { itemCents } from "@/lib/domain/bill";
import { isCheckoutLive } from "@/lib/domain/machine";
import type { ProductDTO, SessionDTO, SessionItemDTO } from "@/lib/domain/types";
import { formatTime } from "@/lib/format";
import { formatCents } from "@/lib/pricing";

interface Props {
  session: SessionDTO;
  /** Reloads the open sheet's detail. The floor is refetched here as well. */
  reload: () => Promise<void>;
  /** The sheet is mid-action (e.g. sending a charge): don't let items be added meanwhile. */
  busy?: boolean;
}

/** After an add timed out the server may still be finishing it; hold the add buttons this long. */
const TIMEOUT_HOLD_MS = 5000;

const NO_PRODUCTS: ProductDTO[] = [];

/** Add and remove snacks/drinks on a bill. Shared by the session detail sheet and the charge sheet. */
export function ItemsPanel({ session, reload, busy = false }: Props) {
  const router = useRouter();
  const toast = useToast();
  const { floor, offline, refetch } = useFloor();
  const { run, pending: removing } = useAction();
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const inflight = useRef(new Set<string>());
  const [cooling, setCooling] = useState(false);
  const [toRemove, setToRemove] = useState<SessionItemDTO | null>(null);

  const [query, setQuery] = useState("");
  const [pickedCategory, setPickedCategory] = useState(getLastCategory);

  const products = floor?.products ?? NO_PRODUCTS;
  const items = session.items;
  const categories = useMemo(() => categoryOptions(products), [products]);
  // A remembered category may not exist in this catalogue any more.
  const category = categories.some((c) => c.key === pickedCategory) ? pickedCategory : ALL_CATEGORY;
  const shown = useMemo(() => filterProducts(products, category, query), [products, category, query]);
  // A category is laid out brand by brand; "All" category by category; search results as one list.
  const sections = useMemo(() => itemSections(shown, category, query), [shown, category, query]);
  const pickCategory = (key: string) => {
    setLastCategory(key);
    setPickedCategory(key);
  };
  const tz = floor?.pricing.settings.timezone ?? "Australia/Sydney";
  // A part is one share of another bill: nothing is added to it or taken off it.
  const editable = billCan(session, "add_item");
  const cardLive = session.status === "awaiting_payment" && isCheckoutLive(session.checkout?.status);
  const blocked = cardLive ? "Cancel the card request before changing the bill." : offline ? "No connection. Wait for it to come back before changing the bill." : null;

  /** A request timed out: the server may still be finishing it, so hold the add buttons a moment. */
  const holdAfterTimeout = () => {
    setCooling(true);
    setTimeout(() => setCooling(false), TIMEOUT_HOLD_MS);
  };

  /** Resolves true when the item went on the bill. */
  const add = async (productId: string): Promise<boolean> => {
    if (inflight.current.has(productId)) return false;
    inflight.current.add(productId);
    setAdding(new Set(inflight.current));
    try {
      await api.addItem(session.id, productId, 1);
      await Promise.all([reload(), refetch()]);
      return true;
    } catch (e) {
      const dest = authRedirect(e);
      if (dest) {
        router.replace(dest);
      } else {
        toast.show(errorMessage(e), "error");
        if (e instanceof ApiError && e.status === 0) holdAfterTimeout();
        // The bill may have moved under us (another iPad, or a card request started): resync.
        if (e instanceof ApiError && e.status === 409) await Promise.all([reload(), refetch()]);
      }
      return false;
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

  const holdReason = blocked ?? (busy || cooling ? "Wait a moment, then try again." : null);

  // The buttons below are memoised; they call whatever `add` is current without being re-rendered for it.
  const addRef = useRef(add);
  useEffect(() => {
    addRef.current = add;
  });
  const onAdd = useCallback((productId: string) => void addRef.current(productId), []);

  const addScanned = async (p: ProductDTO) => {
    if (await add(p.id)) toast.show(`${p.name} added, ${formatCents(p.priceCents)}`, "success");
  };

  /** A barcode came in, from a scanner or typed into the search box. */
  const handleScan = (code: string) => {
    if (holdReason) {
      // Scanner digits typed into the search box would otherwise leave it showing no matches.
      if (normaliseBarcode(query) !== null) setQuery("");
      toast.show(holdReason, "error");
      return;
    }
    const matches = findByBarcode(products, code);
    if (matches.length === 0) {
      setQuery("");
      toast.show(`No item has the barcode ${code}. Add it to the item in Square, then refresh under Admin → Items.`, "error");
    } else if (matches.length === 1) {
      setQuery("");
      void addScanned(matches[0]);
    } else {
      setQuery(code);
      toast.show(`More than one item has the barcode ${code}. Pick the right one below.`, "error");
    }
  };
  useScanHandler(handleScan, editable && products.length > 0);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // A scanner's Enter was already taken by the window-level listener.
    if (e.key !== "Enter" || e.nativeEvent.defaultPrevented) return;
    e.preventDefault();
    if (normaliseBarcode(query) !== null) {
      handleScan(query.replace(/[\s-]/g, ""));
    } else if (shown.length === 1 && !holdReason) {
      setQuery("");
      void addScanned(shown[0]);
    } else {
      // Put the keyboard away so the matches are in view.
      e.currentTarget.blur();
    }
  };

  const clearSearch = () => {
    setQuery("");
    pickCategory(ALL_CATEGORY);
  };

  if (session.kind === "part") return null;
  if (products.length === 0 && items.length === 0 && !editable) return null;

  return (
    <section aria-label="Items" className="flex flex-col gap-3">
      <h3 className="text-lg font-semibold">Items</h3>

      {editable ? (
        <>
          {blocked ? <p className="text-warn">{blocked}</p> : null}
          {products.length === 0 ? (
            items.length === 0 ? (
              <p className="text-muted">No items to add yet. A manager can load them under Admin → Items.</p>
            ) : null
          ) : (
            <div className="flex flex-col gap-3">
              <div className="relative">
                <input
                  type="text"
                  data-scan-field
                  inputMode="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-label="Search or scan"
                  placeholder="Search or scan"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={onSearchKey}
                  className={`${inputClass} pr-12`}
                />
                {query ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                    className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-xl text-2xl leading-none text-muted active:text-chalk"
                  >
                    <span aria-hidden>×</span>
                  </button>
                ) : null}
              </div>

              {categories.length > 2 ? (
                <div role="group" aria-label="Category" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
                  {categories.map((c) => (
                    <button
                      key={c.key}
                      type="button"
                      aria-pressed={c.key === category}
                      onClick={() => pickCategory(c.key)}
                      className={`flex min-h-11 shrink-0 select-none items-center gap-2 rounded-full border px-4 text-base font-semibold transition-colors ${
                        c.key === category ? "border-brand bg-brand text-on-brand" : "border-line bg-surface-2 text-chalk active:bg-line"
                      }`}
                    >
                      {c.label}
                      <span className={`text-sm font-normal tabular-nums ${c.key === category ? "" : "text-muted"}`}>{c.count}</span>
                    </button>
                  ))}
                </div>
              ) : null}

              {shown.length === 0 ? (
                <div className="flex flex-col items-start gap-3 rounded-xl border border-line bg-surface-2 p-4">
                  <p className="text-muted">No items match.</p>
                  <Button onClick={clearSearch}>Clear search</Button>
                </div>
              ) : (
                // Capped so the bill below stays in reach. Scrolling past its end carries on to the sheet.
                <div className="flex max-h-[min(26rem,50dvh)] flex-col gap-4 overflow-y-auto">
                  {sections.map((s) => (
                    <div key={s.key} role="group" aria-label={s.heading ?? "Items"} className="flex flex-col gap-2">
                      {s.heading ? (
                        <h4 className="sticky top-0 z-10 bg-surface py-1 text-sm font-semibold uppercase tracking-wide text-muted">
                          {s.heading}
                        </h4>
                      ) : null}
                      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {s.items.map(({ product: p, label }) => (
                          <ProductButton
                            key={p.id}
                            product={p}
                            label={label}
                            disabled={!!holdReason}
                            adding={adding.has(p.id)}
                            onAdd={onAdd}
                          />
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <CustomCharge
            sessionId={session.id}
            disabled={!!blocked || busy || cooling}
            onAdded={reload}
            onTimedOut={holdAfterTimeout}
          />
        </>
      ) : null}

      {items.length > 0 ? (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {items.map((i) => (
            <li key={i.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {lineLabel(i)}
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
                    disabled={!!blocked || busy || removing}
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
              {lineLabel(toRemove)} <span className="tabular-nums text-muted">· {formatCents(itemCents(toRemove))}</span>
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

interface ProductButtonProps {
  product: ProductDTO;
  /** What the button shows: the name, or the name without the brand heading it sits under. */
  label: string;
  disabled: boolean;
  adding: boolean;
  onAdd: (productId: string) => void;
}

/** One item in the grid. Stock is shown for information; it never stops an add. */
const ProductButton = memo(function ProductButton({ product: p, label, disabled, adding, onAdd }: ProductButtonProps) {
  const stock = stockLabel(p.stock);
  return (
    <li className="flex">
      <button
        type="button"
        disabled={disabled || adding}
        aria-busy={adding}
        aria-label={`Add ${p.name}, ${formatCents(p.priceCents)}${p.taxed ? "" : ", GST-free"}${stock ? `, ${stock.text.toLowerCase()}` : ""}`}
        onClick={() => onAdd(p.id)}
        className="flex min-h-20 w-full select-none flex-col items-start justify-between gap-1 rounded-xl border border-line bg-surface-2 px-4 py-3 text-left transition-colors active:bg-line disabled:cursor-not-allowed disabled:opacity-45"
      >
        <span className="line-clamp-2 text-base font-semibold leading-snug">{label}</span>
        <span className="flex flex-wrap items-baseline gap-x-2 text-base tabular-nums text-muted">
          {adding ? "Adding…" : formatCents(p.priceCents)}
          {!adding && !p.taxed ? <span className="text-sm">GST-free</span> : null}
        </span>
        {stock && !adding ? (
          <span className={`text-sm font-semibold ${stock.tone === "out" ? "text-danger-text" : "text-warn"}`}>{stock.text}</span>
        ) : null}
      </button>
    </li>
  );
});
