import "server-only";
import * as catalog from "@/lib/square/catalog";
import { db, withTx, type Tx } from "./db";
import { squareEnv, squareLooksConfigured } from "./env";
import { AppError } from "./errors";
import type { DiscountRow, ProductRow } from "./repo";

// ---------------------------------------------------------------------------
// Square catalogue gateway (swappable in tests)
// ---------------------------------------------------------------------------

export interface CatalogGateway {
  list: typeof catalog.listCatalogObjects;
}

let gateway: CatalogGateway = { list: catalog.listCatalogObjects };

export function setCatalogGatewayForTests(g: CatalogGateway): void {
  gateway = g;
}

// ---------------------------------------------------------------------------
// Catalogue sync
// ---------------------------------------------------------------------------

/**
 * Re-reads the item list from Square and brings `products` into line with it. Returns how many
 * products are for sale. Items that have left the catalogue are marked inactive, never deleted,
 * so old bills still resolve.
 *
 * Neither `products` nor `catalog_state` has a floor-broadcast trigger, so this can run in the
 * background without making the iPads refetch.
 */
export async function syncProducts(): Promise<number> {
  try {
    const locationId = squareEnv().SQUARE_LOCATION_ID;
    // Square is called before the transaction opens, so a slow catalogue read holds no locks.
    const { products, tableHireVariationId, discounts, taxWarning } = catalog.mapCatalog(await gateway.list(), locationId);

    return await withTx(async (tx) => {
      // The state row doubles as the lock: two syncs at once would otherwise both try to insert
      // the same new product.
      await tx`select 1 from public.catalog_state where id for update`;
      const existing = await tx<ProductRow[]>`
        select id, item_id, name, price_cents, taxed, category, sort_order, active, barcode, sku, tracked, stock_count, stock_at
        from public.products`;
      const current = new Map(existing.map((r) => [r.id, r]));

      for (const p of products) {
        const row = current.get(p.id);
        current.delete(p.id);
        if (!row) {
          await tx`
            insert into public.products (id, item_id, name, price_cents, taxed, category, sort_order, active, barcode, sku, tracked, tracked_since)
            values (${p.id}, ${p.itemId}, ${p.name}, ${p.priceCents}, ${p.taxed}, ${p.category}, ${p.sortOrder}, true,
                    ${p.barcode}, ${p.sku}, ${p.tracked}, case when ${p.tracked}::boolean then now() end)`;
          continue;
        }
        const same =
          row.active &&
          row.item_id === p.itemId &&
          row.name === p.name &&
          row.price_cents === p.priceCents &&
          row.taxed === p.taxed &&
          row.category === p.category &&
          row.sort_order === p.sortOrder &&
          row.barcode === p.barcode &&
          row.sku === p.sku &&
          row.tracked === p.tracked;
        // Only rows that changed are written, so updated_at says when a price or name last moved.
        if (same) continue;
        // `tracked_since` is stamped when tracking switches on and left alone otherwise (switching off
        // keeps it; the next switch on overwrites it). It only ever changes together with `tracked`,
        // so an unchanged product is still not rewritten.
        await tx`
          update public.products set
            item_id = ${p.itemId}, name = ${p.name}, price_cents = ${p.priceCents}, taxed = ${p.taxed},
            category = ${p.category}, sort_order = ${p.sortOrder}, active = true, synced_at = now(),
            barcode = ${p.barcode}, sku = ${p.sku}, tracked = ${p.tracked},
            tracked_since = case when ${p.tracked}::boolean and not tracked then now() else tracked_since end
          where id = ${p.id}`;
      }

      // Whatever is left is no longer sold at this location.
      const gone = [...current.values()].filter((r) => r.active).map((r) => r.id);
      if (gone.length > 0) {
        await tx`update public.products set active = false, synced_at = now() where id = any(${gone}::text[])`;
      }

      // Discounts ride along in the same transaction, behind a savepoint: if writing them fails
      // for any reason, the item list above is still saved and the discounts stay as they were.
      let discountsError: string | null = null;
      try {
        await tx.savepoint((sp) => syncDiscounts(sp, discounts));
      } catch (e) {
        console.warn("[square] discounts not updated", e instanceof Error ? e.message : e);
        discountsError = "The item list was updated, but the discounts couldn't be. Try again; if it keeps happening, check the discounts in Square.";
      }

      await tx`
        update public.catalog_state
        set synced_at = now(), last_error = ${discountsError}, table_hire_variation_id = ${tableHireVariationId},
            tax_warning = ${taxWarning}
        where id`;
      return products.length;
    });
  } catch (e) {
    // Recorded after the failed transaction has rolled back, so Admin → Items can say what went wrong.
    const message = e instanceof AppError ? e.message : "Couldn't update the item list from Square.";
    try {
      await db()`update public.catalog_state set last_error = ${message.slice(0, 300)} where id`;
    } catch {
      // The database is the problem; the original error is the one worth reporting.
    }
    throw e;
  }
}

/**
 * Brings `discounts` into line with what Square has. Same rules as products: only rows that
 * changed are written, and a discount that has left the catalogue (or can no longer be used here)
 * is marked inactive, never deleted, so bills that carry it still say what it was. An empty list
 * from Square simply deactivates every discount; it never touches products.
 *
 * `discounts` has no floor-broadcast trigger, so this is safe in the background refresh.
 */
async function syncDiscounts(tx: Tx, discounts: readonly catalog.CatalogDiscount[]): Promise<void> {
  const existing = await tx<DiscountRow[]>`select id, name, kind, value, active from public.discounts`;
  const current = new Map(existing.map((r) => [r.id, r]));

  for (const d of discounts) {
    const row = current.get(d.id);
    current.delete(d.id);
    if (!row) {
      await tx`
        insert into public.discounts (id, name, kind, value, active)
        values (${d.id}, ${d.name}, ${d.kind}, ${d.value}, true)`;
      continue;
    }
    if (row.active && row.name === d.name && row.kind === d.kind && row.value === d.value) continue;
    await tx`
      update public.discounts set name = ${d.name}, kind = ${d.kind}, value = ${d.value}, active = true, synced_at = now()
      where id = ${d.id}`;
  }

  const gone = [...current.values()].filter((r) => r.active).map((r) => r.id);
  if (gone.length > 0) {
    await tx`update public.discounts set active = false, synced_at = now() where id = any(${gone}::text[])`;
  }
}

/**
 * For `after()` on the floor route: keeps the item list fresh without anyone pressing a button.
 * Can never throw, and does nothing when Square isn't configured.
 *
 * Runs after every floor fetch, so it must not write to a table with a floor-broadcast trigger
 * (those fire even for an UPDATE that matches no rows, and every iPad would refetch, run this
 * again and loop forever). `catalog_state` and `products` have no such trigger.
 */
export async function refreshProductsInBackground(): Promise<void> {
  try {
    if (!squareLooksConfigured()) return;
    // Claim the refresh by stamping synced_at first: of three iPads polling at once only one gets
    // the row back, and a failing Square call isn't retried until the next window.
    const claimed = await db()<{ id: boolean }[]>`
      update public.catalog_state set synced_at = now()
      where id and (synced_at is null or synced_at < now() - interval '10 minutes')
      returning id`;
    if (claimed.length === 0) return;
    await syncProducts();
  } catch (e) {
    console.warn("[square] item list refresh skipped", e instanceof Error ? e.message : e);
  }
}
