import "server-only";
import * as catalog from "@/lib/square/catalog";
import { db, withTx } from "./db";
import { squareEnv, squareEnvironmentOrNull } from "./env";
import { AppError } from "./errors";
import type { ProductRow } from "./repo";

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
    const { products, tableHireVariationId } = catalog.mapCatalog(await gateway.list(), locationId);

    return await withTx(async (tx) => {
      // The state row doubles as the lock: two syncs at once would otherwise both try to insert
      // the same new product.
      await tx`select 1 from public.catalog_state where id for update`;
      const existing = await tx<ProductRow[]>`
        select id, item_id, name, price_cents, taxed, category, sort_order, active from public.products`;
      const current = new Map(existing.map((r) => [r.id, r]));

      for (const p of products) {
        const row = current.get(p.id);
        current.delete(p.id);
        if (!row) {
          await tx`
            insert into public.products (id, item_id, name, price_cents, taxed, category, sort_order, active)
            values (${p.id}, ${p.itemId}, ${p.name}, ${p.priceCents}, ${p.taxed}, ${p.category}, ${p.sortOrder}, true)`;
          continue;
        }
        const same =
          row.active &&
          row.item_id === p.itemId &&
          row.name === p.name &&
          row.price_cents === p.priceCents &&
          row.taxed === p.taxed &&
          row.category === p.category &&
          row.sort_order === p.sortOrder;
        // Only rows that changed are written, so updated_at says when a price or name last moved.
        if (same) continue;
        await tx`
          update public.products set
            item_id = ${p.itemId}, name = ${p.name}, price_cents = ${p.priceCents}, taxed = ${p.taxed},
            category = ${p.category}, sort_order = ${p.sortOrder}, active = true, synced_at = now()
          where id = ${p.id}`;
      }

      // Whatever is left is no longer sold at this location.
      const gone = [...current.values()].filter((r) => r.active).map((r) => r.id);
      if (gone.length > 0) {
        await tx`update public.products set active = false, synced_at = now() where id = any(${gone}::text[])`;
      }

      await tx`
        update public.catalog_state
        set synced_at = now(), last_error = null, table_hire_variation_id = ${tableHireVariationId}
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

/** Peek without validating or logging: is there any point asking Square? */
function squareLooksConfigured(): boolean {
  return squareEnvironmentOrNull() !== null && !!process.env.SQUARE_ACCESS_TOKEN && !!process.env.SQUARE_LOCATION_ID;
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
