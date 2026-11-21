import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Square } from "square";
import { bootHarness, type Harness } from "./helpers/harness";
import { squareRejection } from "./helpers/fake-gateway";
import { getAdminState, setItemiseCharges } from "@/lib/server/admin";
import { resetEnvCacheForTests } from "@/lib/server/env";
import { AppError } from "@/lib/server/errors";
import { refreshProductsInBackground, syncProducts } from "@/lib/server/items";
import { getFloor, getSessionDetail, getSummary, getUnpaid } from "@/lib/server/queries";
import { addItem, markPaid, removeItem, startSession, stopSession, voidSession } from "@/lib/server/sessions";
import { mapCatalog } from "@/lib/square/catalog";
import { at, seedProduct } from "./helpers/util";

let h: Harness;
beforeAll(async () => {
  h = await bootHarness();
  // Stand-in for Supabase's realtime.send: records each broadcast so the tests can count them.
  await h.raw(null, `create schema realtime`);
  await h.raw(null, `create table realtime.sent (id serial primary key, topic text not null, event text not null)`);
  await h.raw(
    null,
    `create function realtime.send(payload jsonb, event text, topic text, private boolean) returns void
     language sql as $$ insert into realtime.sent (topic, event) values (topic, event) $$`,
  );
});
afterAll(async () => {
  await h?.close();
});
beforeEach(async () => {
  await h.reset();
});

const LOC = "LOC_TEST";
const broadcasts = async () => (await h.raw<{ n: number }>(null, `select count(*)::int as n from realtime.sent`))[0]?.n ?? 0;

// --- catalogue fixtures, in the shape the SDK returns them ------------------------------------

interface VarOpts {
  name?: string;
  cents?: number;
  pricing?: "FIXED_PRICING" | "VARIABLE_PRICING";
  currency?: "AUD" | "USD";
  presence?: Partial<Pick<Square.CatalogObject.ItemVariation, "presentAtAllLocations" | "presentAtLocationIds" | "absentAtLocationIds">>;
  data?: Partial<Square.CatalogItemVariation>;
}

function variation(id: string, o: VarOpts = {}): Square.CatalogObject.ItemVariation {
  const pricing = o.pricing ?? "FIXED_PRICING";
  return {
    type: "ITEM_VARIATION",
    id,
    presentAtAllLocations: true,
    ...o.presence,
    itemVariationData: {
      name: o.name ?? "Regular",
      pricingType: pricing,
      ...(pricing === "FIXED_PRICING" ? { priceMoney: { amount: BigInt(o.cents ?? 450), currency: o.currency ?? "AUD" } } : {}),
      ...o.data,
    },
  };
}

interface ItemOpts {
  taxIds?: string[];
  categoryIds?: string[];
  presence?: Partial<Pick<Square.CatalogObject.Item, "presentAtAllLocations" | "presentAtLocationIds" | "absentAtLocationIds">>;
  data?: Partial<Square.CatalogItem>;
}

function item(id: string, name: string, variations: Square.CatalogObject.ItemVariation[], o: ItemOpts = {}): Square.CatalogObject.Item {
  return {
    type: "ITEM",
    id,
    presentAtAllLocations: true,
    ...o.presence,
    itemData: {
      name,
      productType: "REGULAR",
      taxIds: o.taxIds ?? ["TAX_GST"],
      categories: (o.categoryIds ?? []).map((c) => ({ id: c })),
      variations,
      ...o.data,
    },
  };
}

const category = (id: string, name: string): Square.CatalogObject.Category => ({ type: "CATEGORY", id, categoryData: { name } });

interface DbProduct {
  id: string;
  item_id: string;
  name: string;
  price_cents: number;
  taxed: boolean;
  category: string | null;
  sort_order: number;
  active: boolean;
  updated_at: Date;
}
const dbProducts = () => h.sql<DbProduct[]>`select * from public.products order by sort_order, name`;
const state = async () =>
  (await h.sql<{ synced_at: Date | null; table_hire_variation_id: string | null; last_error: string | null }[]>`
    select synced_at, table_hire_variation_id, last_error from public.catalog_state`)[0];

describe("C1. catalogue mapping", () => {
  it("a product is one fixed-price AUD variation sold at our location", () => {
    const { products } = mapCatalog(
      [
        category("CAT_DRINKS", "Drinks"),
        category("CAT_SNACKS", "Snacks"),
        item("I_COKE", "Coke", [variation("V_COKE", { cents: 450 })], { categoryIds: ["CAT_DRINKS"] }),
        item("I_CHIPS", " Chips ", [variation("V_CHIPS", { cents: 600 })], { categoryIds: ["CAT_SNACKS", "CAT_DRINKS"] }),
      ],
      LOC,
    );
    expect(products).toEqual([
      { id: "V_COKE", itemId: "I_COKE", name: "Coke", priceCents: 450, taxed: true, category: "Drinks", barcode: null, sku: null, tracked: false, imageUrl: null, sortOrder: 0 },
      { id: "V_CHIPS", itemId: "I_CHIPS", name: "Chips", priceCents: 600, taxed: true, category: "Snacks", barcode: null, sku: null, tracked: false, imageUrl: null, sortOrder: 1 },
    ]);
    // plain numbers, safe to JSON.stringify (the SDK hands back bigint)
    expect(() => JSON.stringify(products)).not.toThrow();
  });

  it("leaves out variable-price, archived, appointment, deleted and non-AUD items", () => {
    const { products } = mapCatalog(
      [
        item("I_OPEN", "Open price", [variation("V_OPEN", { pricing: "VARIABLE_PRICING" })]),
        item("I_ARCH", "Archived", [variation("V_ARCH")], { data: { isArchived: true } }),
        item("I_APPT", "Lesson", [variation("V_APPT")], { data: { productType: "APPOINTMENTS_SERVICE" } }),
        { ...item("I_DEL", "Deleted", [variation("V_DEL")]), isDeleted: true },
        item("I_USD", "Imported", [variation("V_USD", { currency: "USD" })]),
        item("I_NOPRICE", "No price", [variation("V_NOPRICE", { data: { priceMoney: undefined } })]),
        item("I_HUGE", "Too dear", [variation("V_HUGE", { cents: 1_000_001 })]),
        item("I_COMPONENT", "Keg", [variation("V_KEG", { data: { sellable: false } })]),
        item("I_OK", "Kept", [variation("V_OK")]),
      ],
      LOC,
    );
    expect(products.map((p) => p.id)).toEqual(["V_OK"]);
  });

  it("leaves out anything not sold at our location (item or variation)", () => {
    const elsewhere = { presentAtAllLocations: false, presentAtLocationIds: ["LOC_OTHER"] };
    const { products } = mapCatalog(
      [
        item("I_1", "Item elsewhere", [variation("V_1")], { presence: elsewhere }),
        item("I_2", "Variation elsewhere", [variation("V_2", { presence: elsewhere })]),
        item("I_3", "Absent here", [variation("V_3")], { presence: { absentAtLocationIds: [LOC] } }),
        item("I_4", "Variation absent here", [variation("V_4", { presence: { absentAtLocationIds: [LOC] } })]),
        item("I_5", "Listed here", [variation("V_5", { presence: { presentAtAllLocations: false, presentAtLocationIds: [LOC] } })], {
          presence: { presentAtAllLocations: false, presentAtLocationIds: ["LOC_OTHER", LOC] },
        }),
        item("I_6", "Everywhere but one", [variation("V_6")], { presence: { absentAtLocationIds: ["LOC_OTHER"] } }),
      ],
      LOC,
    );
    expect(products.map((p) => p.id).sort()).toEqual(["V_5", "V_6"]);
  });

  it("an item with no tax attached is GST-free", () => {
    const { products } = mapCatalog(
      [
        item("I_WATER", "Water", [variation("V_WATER")], { taxIds: [] }),
        item("I_MILK", "Milk", [variation("V_MILK")], { data: { taxIds: null } }),
        item("I_COKE", "Coke", [variation("V_COKE")]),
      ],
      LOC,
    );
    expect(Object.fromEntries(products.map((p) => [p.id, p.taxed]))).toEqual({ V_WATER: false, V_MILK: false, V_COKE: true });
  });

  it("adds the variation name only when the item has more than one sellable variation", () => {
    const { products } = mapCatalog(
      [
        item("I_COFFEE", "Coffee", [variation("V_SMALL", { name: "Small", cents: 400 }), variation("V_LARGE", { name: "Large", cents: 500 })]),
        item("I_PIE", "Pie", [variation("V_PIE", { name: "Regular" })]),
        // two variations, but only one can be sold here → no suffix
        item("I_BEER", "Beer", [variation("V_BEER", { name: "Schooner" }), variation("V_BEER_OPEN", { name: "Jug", pricing: "VARIABLE_PRICING" })]),
      ],
      LOC,
    );
    expect(products.map((p) => p.name)).toEqual(["Beer", "Coffee – Large", "Coffee – Small", "Pie"]);
  });

  it("orders by category then name, uncategorised last, and the order is stable", () => {
    const objects = [
      category("CAT_S", "Snacks"),
      category("CAT_D", "Drinks"),
      item("I_1", "Zinger", [variation("V_1")]),
      item("I_2", "chips", [variation("V_2")], { categoryIds: ["CAT_S"] }),
      item("I_3", "Water", [variation("V_3")], { categoryIds: ["CAT_D"] }),
      item("I_4", "Coke", [variation("V_4")], { categoryIds: ["CAT_D"] }),
      item("I_5", "Apple", [variation("V_5")]),
      // an unknown category id falls back to the legacy categoryId field
      item("I_6", "Bar", [variation("V_6")], { categoryIds: ["CAT_GONE"], data: { categoryId: "CAT_S", categories: [{ id: "CAT_GONE" }] } }),
    ];
    const a = mapCatalog(objects, LOC).products;
    expect(a.map((p) => [p.category, p.name, p.sortOrder])).toEqual([
      ["Drinks", "Coke", 0],
      ["Drinks", "Water", 1],
      ["Snacks", "Bar", 2],
      ["Snacks", "chips", 3],
      [null, "Apple", 4],
      [null, "Zinger", 5],
    ]);
    expect(mapCatalog([...objects].reverse(), LOC).products).toEqual(a);
  });

  it("uses the location's own price when the variation has an override", () => {
    const { products } = mapCatalog(
      [
        item("I_COKE", "Coke", [
          variation("V_COKE", {
            cents: 450,
            data: {
              locationOverrides: [
                { locationId: "LOC_OTHER", priceMoney: { amount: BigInt(999), currency: "AUD" } },
                { locationId: LOC, priceMoney: { amount: BigInt(500), currency: "AUD" } },
              ],
            },
          }),
        ]),
        item("I_PIE", "Pie", [variation("V_PIE", { data: { locationOverrides: [{ locationId: LOC, pricingType: "VARIABLE_PRICING" }] } })]),
      ],
      LOC,
    );
    expect(products.map((p) => [p.id, p.priceCents])).toEqual([["V_COKE", 500]]);
  });

  it("takes the variation's own picture, else the item's first that still exists; odd URLs are left out", () => {
    const img = (id: string, url: string, deleted = false): Square.CatalogObject.Image => ({
      type: "IMAGE",
      id,
      isDeleted: deleted,
      imageData: { url },
    });
    const S3 = "https://items-images-production.s3.us-west-2.amazonaws.com/files";
    const { products } = mapCatalog(
      [
        img("IMG_ITEM", `${S3}/aaa/original.jpeg`),
        img("IMG_VAR", `${S3}/bbb/original.png`),
        img("IMG_GONE", `${S3}/ccc/original.jpeg`, true),
        img("IMG_ELSEWHERE", "https://example.com/evil.jpeg"),
        item("I_COKE", "Coke", [variation("V_CAN", { name: "Can" }), variation("V_BOTTLE", { name: "Bottle", data: { imageIds: ["IMG_VAR"] } })], {
          data: { imageIds: ["IMG_GONE", "IMG_ITEM"] },
        }),
        item("I_PIE", "Pie", [variation("V_PIE")], { data: { imageIds: ["IMG_ELSEWHERE", "IMG_MISSING"] } }),
        item("I_WATER", "Water", [variation("V_WATER")]),
      ],
      LOC,
    );
    expect(Object.fromEntries(products.map((p) => [p.id, p.imageUrl]))).toEqual({
      V_CAN: `${S3}/aaa/original.jpeg`,
      V_BOTTLE: `${S3}/bbb/original.png`,
      V_PIE: null,
      V_WATER: null,
    });
  });

  it("finds the Table hire variation: name match is trimmed and case-insensitive, and it must be variable-price here", () => {
    const hire = (name: string, vars: Square.CatalogObject.ItemVariation[], o: ItemOpts = {}) => item("I_HIRE", name, vars, o);
    const open = variation("V_HIRE", { pricing: "VARIABLE_PRICING" });

    expect(mapCatalog([hire("  TABLE Hire ", [open])], LOC)).toEqual({ products: [], tableHireVariationId: "V_HIRE", discounts: [], taxWarning: null });
    expect(mapCatalog([hire("Table hire (per hour)", [open])], LOC).tableHireVariationId).toBeNull();
    expect(mapCatalog([hire("Table hire", [variation("V_FIXED", { cents: 2500 })])], LOC).tableHireVariationId).toBeNull();
    expect(mapCatalog([hire("Table hire", [variation("V_HIRE", { pricing: "VARIABLE_PRICING", presence: { absentAtLocationIds: [LOC] } })])], LOC).tableHireVariationId).toBeNull();
    expect(mapCatalog([hire("Table hire", [open], { data: { isArchived: true } })], LOC).tableHireVariationId).toBeNull();
    expect(mapCatalog([item("I_COKE", "Coke", [variation("V_COKE")])], LOC).tableHireVariationId).toBeNull();
  });
});

describe("C2. syncProducts", () => {
  const base = () => [
    category("CAT_D", "Drinks"),
    item("I_COKE", "Coke", [variation("V_COKE", { cents: 450 })], { categoryIds: ["CAT_D"] }),
    item("I_WATER", "Water", [variation("V_WATER", { cents: 300 })], { categoryIds: ["CAT_D"], taxIds: [] }),
    item("I_HIRE", "Table hire", [variation("V_HIRE", { pricing: "VARIABLE_PRICING" })]),
  ];

  it("fills products, links Table hire, stamps synced_at and returns the active count", async () => {
    h.catalog.objects = base();
    await h.sql`update public.catalog_state set last_error = 'old failure'`;
    expect(await syncProducts()).toBe(2);
    expect((await dbProducts()).map(({ id, item_id, name, price_cents, taxed, category: c, sort_order, active }) => ({ id, item_id, name, price_cents, taxed, c, sort_order, active }))).toEqual([
      { id: "V_COKE", item_id: "I_COKE", name: "Coke", price_cents: 450, taxed: true, c: "Drinks", sort_order: 0, active: true },
      { id: "V_WATER", item_id: "I_WATER", name: "Water", price_cents: 300, taxed: false, c: "Drinks", sort_order: 1, active: true },
    ]);
    const s = await state();
    expect(s.synced_at).toBeInstanceOf(Date);
    expect(s).toMatchObject({ table_hire_variation_id: "V_HIRE", last_error: null });
  });

  it("unchanged rows are not rewritten; a changed one is", async () => {
    h.catalog.objects = base();
    await syncProducts();
    // Backdate the rows (replica mode skips the touch trigger) so any rewrite would show.
    await h.raw(null, `set session_replication_role = replica`);
    try {
      await h.raw(null, `update public.products set updated_at = '2020-01-01T00:00:00Z'`);
    } finally {
      await h.raw(null, `set session_replication_role = origin`);
    }
    const old = new Date("2020-01-01T00:00:00Z");
    expect((await dbProducts()).map((p) => p.updated_at)).toEqual([old, old]);

    await syncProducts();
    expect((await dbProducts()).map((p) => p.updated_at)).toEqual([old, old]);

    h.catalog.objects = [
      category("CAT_D", "Drinks"),
      item("I_COKE", "Coke", [variation("V_COKE", { cents: 480 })], { categoryIds: ["CAT_D"] }),
      item("I_WATER", "Water", [variation("V_WATER", { cents: 300 })], { categoryIds: ["CAT_D"], taxIds: [] }),
    ];
    expect(await syncProducts()).toBe(2);
    const [coke, water] = await dbProducts();
    expect(coke).toMatchObject({ id: "V_COKE", price_cents: 480 });
    expect(coke.updated_at.getTime()).toBeGreaterThan(old.getTime());
    expect(water.updated_at).toEqual(old);
    // Table hire left the catalogue → unlinked
    expect((await state()).table_hire_variation_id).toBeNull();
  });

  it("a picture added, changed or removed in Square follows through on the next sync", async () => {
    const url = (n: string) => `https://items-images-production.s3.us-west-2.amazonaws.com/files/${n}/original.jpeg`;
    const withImage = (n: string | null): Square.CatalogObject[] => [
      ...(n ? [{ type: "IMAGE", id: "IMG_1", imageData: { url: url(n) } } satisfies Square.CatalogObject.Image] : []),
      item("I_COKE", "Coke", [variation("V_COKE")], { data: { imageIds: n ? ["IMG_1"] : [] } }),
    ];
    const image = async () => (await h.sql<{ image_url: string | null }[]>`select image_url from public.products where id = 'V_COKE'`)[0]?.image_url;

    h.catalog.objects = withImage(null);
    await syncProducts();
    expect(await image()).toBeNull();

    h.catalog.objects = withImage("one");
    await syncProducts();
    expect(await image()).toBe(url("one"));
    expect((await getFloor()).products[0]).toMatchObject({ id: "V_COKE", imageUrl: url("one") });

    h.catalog.objects = withImage("two");
    await syncProducts();
    expect(await image()).toBe(url("two"));

    h.catalog.objects = withImage(null);
    await syncProducts();
    expect(await image()).toBeNull();
  });

  it("items that leave Square are marked inactive, never deleted, and come back if they return", async () => {
    h.catalog.objects = base();
    await syncProducts();
    const { sessionId } = await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    await addItem(h.staff.actor, sessionId, "V_WATER", 1);

    h.catalog.objects = base().filter((o) => o.id !== "I_WATER");
    expect(await syncProducts()).toBe(1);
    const rows = await dbProducts();
    expect(rows.map((p) => [p.id, p.active])).toEqual([["V_COKE", true], ["V_WATER", false]]);
    // can't be added any more, but the bill that has it is untouched
    await expect(addItem(h.staff.actor, sessionId, "V_WATER", 1)).rejects.toMatchObject({ status: 409 });
    expect((await getFloor()).sessions[0].items.map((i) => i.name)).toEqual(["Water"]);

    h.catalog.objects = base();
    expect(await syncProducts()).toBe(2);
    expect((await dbProducts()).every((p) => p.active)).toBe(true);
  });

  it("on failure records a short reason, keeps the products, and rethrows", async () => {
    h.catalog.objects = base();
    await syncProducts();
    const before = await state();

    h.catalog.error = new AppError(502, "square_error", "Couldn't reach Square to read the item list. Check the internet connection and try again.");
    await expect(syncProducts()).rejects.toMatchObject({ status: 502, code: "square_error" });
    const s = await state();
    expect(s.last_error).toMatch(/Couldn't reach Square/);
    expect(s.synced_at).toEqual(before.synced_at);
    expect(await dbProducts()).toHaveLength(2);

    // anything that isn't staff-readable is replaced with a plain sentence
    h.catalog.error = new Error("ECONNRESET 10.0.0.1:443");
    await expect(syncProducts()).rejects.toThrow("ECONNRESET");
    expect((await state()).last_error).toBe("Couldn't update the item list from Square.");

    h.catalog.error = null;
    await syncProducts();
    expect((await state()).last_error).toBeNull();
  });

  it("a bad row rolls the whole sync back", async () => {
    h.catalog.objects = base();
    await syncProducts();
    // Two variations with the same id can't both be inserted: the transaction fails as a unit.
    h.catalog.objects = [item("I_NEW", "New", [variation("V_NEW")]), item("I_DUP", "Dup", [variation("V_NEW")])];
    await expect(syncProducts()).rejects.toBeTruthy();
    expect((await dbProducts()).map((p) => [p.id, p.active])).toEqual([["V_COKE", true], ["V_WATER", true]]);
    expect((await state()).last_error).toBe("Couldn't update the item list from Square.");
  });

  it("says so when Square isn't configured", async () => {
    const saved = process.env.SQUARE_LOCATION_ID;
    delete process.env.SQUARE_LOCATION_ID;
    resetEnvCacheForTests();
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(syncProducts()).rejects.toMatchObject({ status: 503, code: "square_not_configured" });
      expect(h.catalog.calls).toBe(0);
    } finally {
      process.env.SQUARE_LOCATION_ID = saved;
      resetEnvCacheForTests();
      err.mockRestore();
    }
  });
});

describe("C3. background refresh (runs after every floor fetch)", () => {
  beforeEach(() => {
    h.catalog.objects = [item("I_COKE", "Coke", [variation("V_COKE")])];
  });

  it("syncs when never synced, then stays quiet for 10 minutes", async () => {
    await refreshProductsInBackground();
    expect(h.catalog.calls).toBe(1);
    expect(await dbProducts()).toHaveLength(1);

    await refreshProductsInBackground();
    await refreshProductsInBackground();
    expect(h.catalog.calls).toBe(1);

    await h.raw(null, `update public.catalog_state set synced_at = now() - interval '9 minutes'`);
    await refreshProductsInBackground();
    expect(h.catalog.calls).toBe(1);

    await h.raw(null, `update public.catalog_state set synced_at = now() - interval '11 minutes'`);
    await refreshProductsInBackground();
    expect(h.catalog.calls).toBe(2);
  });

  it("three iPads at once make one Square call", async () => {
    await Promise.all([refreshProductsInBackground(), refreshProductsInBackground(), refreshProductsInBackground()]);
    expect(h.catalog.calls).toBe(1);
  });

  it("never throws, records the reason, and doesn't hammer Square while it's down", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      h.catalog.error = squareRejection(401, "UNAUTHORIZED", "Square couldn't read the item list: not authorised");
      await expect(refreshProductsInBackground()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect((await state()).last_error).toMatch(/not authorised/);

      await refreshProductsInBackground();
      await refreshProductsInBackground();
      expect(h.catalog.calls).toBe(1); // claimed for this window; next try in 10 minutes
    } finally {
      warn.mockRestore();
    }
  });

  it("never throws even if the database is unhappy", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await h.raw(null, `alter table public.catalog_state rename to catalog_state_gone`);
    try {
      await expect(refreshProductsInBackground()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      await h.raw(null, `alter table public.catalog_state_gone rename to catalog_state`);
      warn.mockRestore();
    }
  });

  it("does nothing, quietly, when Square isn't configured", async () => {
    const saved = process.env.SQUARE_ACCESS_TOKEN;
    delete process.env.SQUARE_ACCESS_TOKEN;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await refreshProductsInBackground();
      expect(h.catalog.calls).toBe(0);
      expect((await state()).synced_at).toBeNull(); // not even claimed
      expect(warn).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      process.env.SQUARE_ACCESS_TOKEN = saved;
      warn.mockRestore();
      err.mockRestore();
    }
  });

  it("R7: sends no floor broadcast — not when it syncs, not when it's throttled, not when it fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // prove the counter works: a write to a broadcast table is seen
      await h.sql`update public.settings set grace_minutes = grace_minutes`;
      const before = await broadcasts();
      expect(before).toBeGreaterThan(0);

      await refreshProductsInBackground(); // first sync: inserts a product
      expect(h.catalog.calls).toBe(1);
      await refreshProductsInBackground(); // throttled: zero-row claim
      await refreshProductsInBackground();

      h.catalog.objects = [item("I_COKE", "Coke", [variation("V_COKE", { cents: 500 })]), item("I_PIE", "Pie", [variation("V_PIE")])];
      await h.raw(null, `update public.catalog_state set synced_at = now() - interval '11 minutes'`);
      await refreshProductsInBackground(); // update + insert
      h.catalog.objects = [];
      await h.raw(null, `update public.catalog_state set synced_at = now() - interval '11 minutes'`);
      await refreshProductsInBackground(); // deactivates everything
      h.catalog.error = new AppError(502, "square_error", "Square is down");
      await h.raw(null, `update public.catalog_state set synced_at = now() - interval '11 minutes'`);
      await refreshProductsInBackground(); // fails: writes last_error
      expect(h.catalog.calls).toBe(4);

      expect(await broadcasts()).toBe(before);
    } finally {
      warn.mockRestore();
    }
  });

  it("R7: no table the refresh writes to has a broadcast trigger; session_items does", async () => {
    const rows = await h.raw<{ t: string }>(
      null,
      `select c.relname as t from pg_trigger g join pg_class c on c.oid = g.tgrelid join pg_proc p on p.oid = g.tgfoid
       where p.proname = 'broadcast_floor_change' and not g.tgisinternal`,
    );
    const withTrigger = rows.map((r) => r.t);
    expect(withTrigger).not.toContain("products");
    expect(withTrigger).not.toContain("catalog_state");
    expect(withTrigger).toContain("session_items");
  });

  it("an item going on or off a bill does broadcast", async () => {
    await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450 });
    const { sessionId } = await startSession(h.staff.actor, h.tableId("Table 1"), at(0));
    const a = await broadcasts();
    const { itemId } = await addItem(h.staff.actor, sessionId, "VAR_COKE", 1);
    const b = await broadcasts();
    expect(b).toBeGreaterThan(a);
    await removeItem(h.staff.actor, sessionId, itemId);
    expect(await broadcasts()).toBeGreaterThan(b);
  });
});

describe("C4. DTOs", () => {
  beforeEach(async () => {
    await seedProduct(h, { id: "VAR_COKE", name: "Coke", priceCents: 450, category: "Drinks", sortOrder: 0 });
    await seedProduct(h, { id: "VAR_WATER", name: "Water", priceCents: 300, taxed: false, category: "Drinks", sortOrder: 1 });
    await seedProduct(h, { id: "VAR_CHIPS", name: "Chips", priceCents: 600, category: null, sortOrder: 2 });
    await seedProduct(h, { id: "VAR_OLD", name: "Old pie", priceCents: 500, active: false, sortOrder: 3 });
  });

  it("floor: active products in display order, and each session carries its live items", async () => {
    const { actor, managerActor } = h.staff;
    const a = (await startSession(actor, h.tableId("Table 1"), at(0))).sessionId;
    const b = (await startSession(actor, h.tableId("Table 2"), at(0))).sessionId;
    const coke = (await addItem(actor, a, "VAR_COKE", 2)).itemId;
    const chips = (await addItem(managerActor, a, "VAR_CHIPS", 1)).itemId;
    await removeItem(actor, a, chips);
    await addItem(actor, a, "VAR_WATER", 1);

    const f = await getFloor();
    expect(f.products).toEqual([
      { id: "VAR_COKE", name: "Coke", priceCents: 450, taxed: true, category: "Drinks", barcode: null, imageUrl: null, stock: null },
      { id: "VAR_WATER", name: "Water", priceCents: 300, taxed: false, category: "Drinks", barcode: null, imageUrl: null, stock: null },
      { id: "VAR_CHIPS", name: "Chips", priceCents: 600, taxed: true, category: null, barcode: null, imageUrl: null, stock: null },
    ]);
    const sa = f.sessions.find((s) => s.id === a);
    expect(sa).toMatchObject({ itemsCents: 1200, totalCents: null });
    expect(sa?.items).toEqual([
      {
        id: coke,
        kind: "product",
        productId: "VAR_COKE",
        name: "Coke",
        unitCents: 450,
        quantity: 2,
        taxed: true,
        addedAt: expect.any(String),
        addedByName: "Sam Staff",
        removedAt: null,
        removedByName: null,
      },
      expect.objectContaining({ productId: "VAR_WATER", unitCents: 300, quantity: 1, taxed: false }),
    ]);
    expect(f.sessions.find((s) => s.id === b)).toMatchObject({ itemsCents: 0, items: [] });
    expect(() => JSON.stringify(f)).not.toThrow();
  });

  it("floor with no products synced has an empty list", async () => {
    await h.sql`update public.products set active = false`;
    expect((await getFloor()).products).toEqual([]);
  });

  it("unpaid list carries items and the whole total", async () => {
    const id = (await startSession(h.staff.actor, h.tableId("Table 1"), at(0))).sessionId;
    await addItem(h.staff.actor, id, "VAR_COKE", 1);
    await stopSession(h.staff.actor, id, at(60));
    const u = await getUnpaid();
    expect(u.sessions[0]).toMatchObject({ id, totalCents: 2950, itemsCents: 450, billedMinutes: 60 });
    expect(u.sessions[0].items.map((i) => i.name)).toEqual(["Coke"]);
  });

  it("detail: breakdown is table time only, removed items are listed separately with who took them off", async () => {
    const { actor, managerActor } = h.staff;
    const id = (await startSession(actor, h.tableId("Table 1"), at(0))).sessionId;
    await addItem(actor, id, "VAR_COKE", 2);
    const chips = (await addItem(actor, id, "VAR_CHIPS", 1)).itemId;
    await removeItem(managerActor, id, chips, at(30));
    await stopSession(actor, id, at(60));

    const d = await getSessionDetail(id);
    expect(d.session).toMatchObject({ totalCents: 3400, itemsCents: 900, billedMinutes: 60 });
    expect(d.session.items.map((i) => i.name)).toEqual(["Coke"]);
    expect(d.breakdown).toMatchObject({ totalCents: 2500, gstCents: 227, billedMinutes: 60 });
    expect((d.breakdown?.totalCents ?? 0) + d.session.itemsCents).toBe(d.session.totalCents);
    expect(d.removedItems).toEqual([
      expect.objectContaining({
        id: chips,
        productId: "VAR_CHIPS",
        name: "Chips",
        unitCents: 600,
        quantity: 1,
        addedByName: "Sam Staff",
        removedAt: at(30).toISOString(),
        removedByName: "Mia Manager",
      }),
    ]);
    expect(d.audit.map((a) => a.action)).toEqual([
      "session.start",
      "session.add_item",
      "session.add_item",
      "session.remove_item",
      "session.stop",
    ]);
  });

  it("detail of a bill with no items has empty lists", async () => {
    const id = (await startSession(h.staff.actor, h.tableId("Table 1"), at(0))).sessionId;
    const d = await getSessionDetail(id);
    expect(d.removedItems).toEqual([]);
    expect(d.session.items).toEqual([]);
    expect(d.session.itemsCents).toBe(0);
  });

  it("summary: splits table time from items and lists what sold, biggest first", async () => {
    const { actor, managerActor, manager } = h.staff;
    await h.sql`update public.settings set business_day_start = '00:00'`;
    const open = async (table: string) => (await startSession(actor, h.tableId(table), at(0))).sessionId;

    // paid: 2500 table + 2 Coke + 1 Chips (and a Water that was taken off)
    const a = await open("Table 1");
    await addItem(actor, a, "VAR_COKE", 2);
    await addItem(actor, a, "VAR_CHIPS", 1);
    await removeItem(actor, a, (await addItem(actor, a, "VAR_WATER", 1)).itemId);
    await stopSession(actor, a, at(60));
    await markPaid(actor, a, "cash", { cardConfirmed: false }, at(61));

    // unpaid: 2500 table + 3 Coke on two lines
    const b = await open("Table 2");
    await addItem(actor, b, "VAR_COKE", 1);
    await addItem(actor, b, "VAR_COKE", 2);
    await stopSession(actor, b, at(60));

    // void: its items don't count
    const c = await open("Table 3");
    await addItem(actor, c, "VAR_CHIPS", 5);
    await stopSession(actor, c, at(60));
    await voidSession(managerActor, manager, c, "Walked out", at(62));

    // still running: not closed, doesn't count
    const d = await open("Table 4");
    await addItem(actor, d, "VAR_WATER", 4);

    const sum = await getSummary("2026-11-20");
    expect(sum.sessions).toEqual({
      count: 2,
      billedMinutes: 120,
      billedCents: 5000 + 900 + 600 + 1350,
      tableCents: 5000,
      itemsCents: 900 + 600 + 1350,
      discountCents: 0,
      writtenOffCents: 0,
    });
    expect(sum.sessions.tableCents + sum.sessions.itemsCents).toBe(sum.sessions.billedCents);
    expect(sum.itemsSold).toEqual([
      { productId: "VAR_COKE", name: "Coke", quantity: 5, cents: 2250 },
      { productId: "VAR_CHIPS", name: "Chips", quantity: 1, cents: 600 },
    ]);
    expect(sum.itemsSold.reduce((n, i) => n + i.cents, 0)).toBe(sum.sessions.itemsCents);
    expect(sum.paid.cash).toEqual({ count: 1, cents: 4000, roundingCents: 0 });
    expect(sum.unpaid).toMatchObject({ count: 1, cents: 3850 });
    expect(() => JSON.stringify(sum)).not.toThrow();
  });

  it("summary with nothing sold", async () => {
    const sum = await getSummary("2026-11-20");
    expect(sum.itemsSold).toEqual([]);
    expect(sum.sessions).toEqual({ count: 0, billedMinutes: 0, billedCents: 0, tableCents: 0, itemsCents: 0, discountCents: 0, writtenOffCents: 0 });
  });

  it("admin state: every product incl. inactive, sync status and the itemise switch", async () => {
    let s = await getAdminState(h.staff.manager);
    expect(s.catalog).toEqual({
      products: [
        { id: "VAR_COKE", name: "Coke", priceCents: 450, taxed: true, category: "Drinks", active: true, barcode: null, imageUrl: null, stock: null, sku: null, tracked: false },
        { id: "VAR_WATER", name: "Water", priceCents: 300, taxed: false, category: "Drinks", active: true, barcode: null, imageUrl: null, stock: null, sku: null, tracked: false },
        { id: "VAR_CHIPS", name: "Chips", priceCents: 600, taxed: true, category: null, active: true, barcode: null, imageUrl: null, stock: null, sku: null, tracked: false },
        { id: "VAR_OLD", name: "Old pie", priceCents: 500, taxed: true, category: null, active: false, barcode: null, imageUrl: null, stock: null, sku: null, tracked: false },
      ],
      discounts: [],
      syncedAt: null,
      tableHireLinked: false,
      lastError: null,
      taxWarning: null,
      stock: { syncedAt: null, lastError: null, pending: 0, failed: 0, lastMoveError: null },
    });
    expect(s.settings.itemiseCharges).toBe(true);

    await h.sql`update public.catalog_state set synced_at = ${at(0)}, table_hire_variation_id = 'V_HIRE', last_error = 'Square is down'`;
    s = await getAdminState(h.staff.manager);
    expect(s.catalog).toMatchObject({ syncedAt: at(0).toISOString(), tableHireLinked: true, lastError: "Square is down" });
  });

  it("setItemiseCharges flips the switch and audits it with the reason; a no-op writes nothing", async () => {
    const { managerActor, manager } = h.staff;
    const rows = () =>
      h.sql<{ approved_by_staff_id: string | null; reason: string | null; before: unknown; after: unknown }[]>`
        select approved_by_staff_id, reason, before, after from public.audit_log where action = 'settings.itemise_charges' order by id`;

    await setItemiseCharges(managerActor, manager, false, "Terminal showing the wrong cart");
    expect((await getAdminState(manager)).settings.itemiseCharges).toBe(false);
    expect(await rows()).toEqual([
      {
        approved_by_staff_id: manager.id,
        reason: "Terminal showing the wrong cart",
        before: { itemise_charges: true },
        after: { itemise_charges: false },
      },
    ]);

    await setItemiseCharges(managerActor, manager, false, "Pressed twice");
    expect(await rows()).toHaveLength(1);
    await expect(setItemiseCharges(managerActor, manager, true, " ")).rejects.toMatchObject({ status: 400 });
    await setItemiseCharges(managerActor, manager, true, "Fixed by Square");
    expect((await getAdminState(manager)).settings.itemiseCharges).toBe(true);
    expect(await rows()).toHaveLength(2);
  });
});

describe("C5. barcodes, the stock-tracking flag and the tax check", () => {
  const tax = (id: string, name: string, inclusionType: "ADDITIVE" | "INCLUSIVE", extra: Partial<Square.CatalogObject.Tax> = {}): Square.CatalogObject.Tax => ({
    type: "TAX",
    id,
    presentAtAllLocations: true,
    taxData: { name, inclusionType, percentage: "10", enabled: true },
    ...extra,
  });

  it("copies the GTIN and SKU, and drops a `upc` that isn't a barcode", () => {
    const { products } = mapCatalog(
      [
        item("I_A", "A", [variation("V_A", { data: { upc: "9300675024235", sku: " COKE-375 " } })]),
        item("I_B", "B", [variation("V_B", { data: { upc: " 0 12345-678905 " } })]),
        item("I_C", "C", [variation("V_C", { data: { upc: "ABC123", sku: "   " } })]),
        item("I_D", "D", [variation("V_D", { data: { upc: "123456789012345" } })]),
        item("I_E", "E", [variation("V_E")]),
      ],
      LOC,
    );
    expect(products.map((p) => [p.id, p.barcode, p.sku])).toEqual([
      ["V_A", "9300675024235", "COKE-375"],
      ["V_B", "012345678905", null],
      ["V_C", null, null],
      ["V_D", null, null],
      ["V_E", null, null],
    ]);
  });

  it("stock is tracked when Square says so, and the location's own setting wins", () => {
    const { products } = mapCatalog(
      [
        item("I_A", "A", [variation("V_A", { data: { trackInventory: true } })]),
        item("I_B", "B", [variation("V_B")]),
        item("I_C", "C", [
          variation("V_C", { data: { trackInventory: true, locationOverrides: [{ locationId: LOC, trackInventory: false }] } }),
        ]),
        item("I_D", "D", [
          variation("V_D", { data: { trackInventory: false, locationOverrides: [{ locationId: LOC, trackInventory: true }] } }),
        ]),
        item("I_E", "E", [
          variation("V_E", { data: { trackInventory: true, locationOverrides: [{ locationId: "LOC_OTHER", trackInventory: false }] } }),
        ]),
      ],
      LOC,
    );
    expect(products.map((p) => [p.id, p.tracked])).toEqual([
      ["V_A", true],
      ["V_B", false],
      ["V_C", false],
      ["V_D", true],
      ["V_E", true],
    ]);
  });

  it("an item in several categories is filed under its reporting category", () => {
    const { products } = mapCatalog(
      [
        category("CAT_MENU", "Pool Hall"),
        category("CAT_DRINKS", "Drinks"),
        item("I_A", "Pepsi", [variation("V_A")], { categoryIds: ["CAT_MENU", "CAT_DRINKS"], data: { reportingCategory: { id: "CAT_DRINKS" } } }),
        // No reporting category: the first category it is in.
        item("I_B", "Snack", [variation("V_B")], { categoryIds: ["CAT_MENU"] }),
        // A reporting category the catalogue doesn't have falls back the same way.
        item("I_C", "Mars", [variation("V_C")], { categoryIds: ["CAT_MENU"], data: { reportingCategory: { id: "CAT_GONE" } } }),
      ],
      LOC,
    );
    expect(products.map((p) => [p.name, p.category])).toEqual([
      ["Pepsi", "Drinks"],
      ["Mars", "Pool Hall"],
      ["Snack", "Pool Hall"],
    ]);
  });

  it("no warning when every tax is included in the price", () => {
    const { taxWarning } = mapCatalog(
      [tax("TAX_GST", "GST", "INCLUSIVE"), item("I_A", "A", [variation("V_A")], { taxIds: ["TAX_GST"] }), item("I_B", "B", [variation("V_B")], { taxIds: [] })],
      LOC,
    );
    expect(taxWarning).toBeNull();
  });

  it("warns, naming the items, when a tax is added on top of the price", () => {
    const objects = [
      tax("TAX_GST", "GST", "INCLUSIVE"),
      tax("TAX_ADD", "GST (added)", "ADDITIVE"),
      item("I_A", "Pepsi", [variation("V_A")], { taxIds: ["TAX_ADD"] }),
      item("I_B", "Coke", [variation("V_B")], { taxIds: ["TAX_GST", "TAX_ADD"] }),
      item("I_C", "Fanta", [variation("V_C")], { taxIds: ["TAX_GST"] }),
      item("I_HIRE", "Table hire", [variation("V_HIRE", { pricing: "VARIABLE_PRICING" })], { taxIds: ["TAX_ADD"] }),
      // Nothing the app can sell: not worth a warning.
      item("I_OPEN", "Open price", [variation("V_OPEN", { pricing: "VARIABLE_PRICING" })], { taxIds: ["TAX_ADD"] }),
    ];
    const { taxWarning, products } = mapCatalog(objects, LOC);
    expect(taxWarning).toMatch(/^3 items have GST \(added\) added on top of the price in Square: Coke, Pepsi, Table hire\./);
    // The check never changes what is for sale.
    expect(products.map((p) => p.name)).toEqual(["Coke", "Fanta", "Pepsi"]);
  });

  it("ignores an added-on tax that is switched off, deleted or not at our location, and caps a long list", () => {
    const quiet = mapCatalog(
      [
        tax("TAX_OFF", "Off", "ADDITIVE", { taxData: { name: "Off", inclusionType: "ADDITIVE", enabled: false } }),
        tax("TAX_DEL", "Deleted", "ADDITIVE", { isDeleted: true }),
        tax("TAX_AWAY", "Away", "ADDITIVE", { presentAtAllLocations: false, presentAtLocationIds: ["LOC_OTHER"] }),
        item("I_A", "A", [variation("V_A")], { taxIds: ["TAX_OFF", "TAX_DEL", "TAX_AWAY"] }),
      ],
      LOC,
    );
    expect(quiet.taxWarning).toBeNull();

    const many = mapCatalog(
      [tax("TAX_ADD", "Sales tax", "ADDITIVE"), ...Array.from({ length: 12 }, (_, i) => item(`I_${i}`, `Item ${String(i).padStart(2, "0")}`, [variation(`V_${i}`)], { taxIds: ["TAX_ADD"] }))],
      LOC,
    );
    expect(many.taxWarning).toMatch(/^12 items have Sales tax added on top of the price in Square: Item 00, Item 01, Item 02 and 9 more\./);
    expect(many.taxWarning?.length).toBeLessThanOrEqual(300);
  });

  it("sync stores barcode, SKU and the tracking flag, rewrites a row only when one changes, and keeps the count", async () => {
    h.catalog.objects = [item("I_A", "Coke", [variation("V_A", { data: { upc: "9300675024235", sku: "COKE", trackInventory: true } })])];
    await syncProducts();
    const rows = () =>
      h.sql<{ barcode: string | null; sku: string | null; tracked: boolean; stock_count: number | null; updated_at: Date }[]>`
        select barcode, sku, tracked, stock_count, updated_at from public.products where id = 'V_A'`;
    const [first] = await rows();
    expect(first).toMatchObject({ barcode: "9300675024235", sku: "COKE", tracked: true, stock_count: null });

    await h.raw(null, `update public.products set stock_count = 7, stock_at = now() where id = 'V_A'`);
    const [counted] = await rows();
    await syncProducts();
    const [again] = await rows();
    expect(again.updated_at.getTime()).toBe(counted.updated_at.getTime());
    expect(again.stock_count).toBe(7);

    h.catalog.objects = [item("I_A", "Coke", [variation("V_A", { data: { upc: "9300675024242", trackInventory: false } })])];
    await syncProducts();
    const [changed] = await rows();
    // The catalogue refresh never touches the count: that belongs to the stock read.
    expect(changed).toMatchObject({ barcode: "9300675024242", sku: null, tracked: false, stock_count: 7 });
  });

  it("sync stamps tracked_since when tracking switches on, keeps it when it switches off, and stamps again on the next switch on", async () => {
    const since = async () => (await h.sql<{ tracked_since: Date | null }[]>`select tracked_since from public.products where id = 'V_A'`)[0].tracked_since;
    const set = (tracked: boolean) => {
      h.catalog.objects = [item("I_A", "Coke", [variation("V_A", { data: { trackInventory: tracked } })])];
      return syncProducts();
    };
    await set(false);
    expect(await since()).toBeNull();

    await set(true);
    const first = await since();
    expect(first).toBeInstanceOf(Date);
    await h.raw(null, `update public.products set tracked_since = '2020-01-01' where id = 'V_A'`);
    await set(true); // nothing changed: not rewritten
    expect((await since())?.getFullYear()).toBe(2020);

    await set(false);
    expect((await since())?.getFullYear()).toBe(2020);
    await set(true);
    expect((await since())?.getFullYear()).toBeGreaterThan(2020);

    // A new item that arrives already tracked.
    h.catalog.objects = [item("I_B", "Pepsi", [variation("V_B", { data: { trackInventory: true } })])];
    await syncProducts();
    expect((await h.sql<{ tracked_since: Date | null }[]>`select tracked_since from public.products where id = 'V_B'`)[0].tracked_since).toBeInstanceOf(Date);
  });

  it("sync records the tax warning and clears it once the catalogue is fixed", async () => {
    const warning = async () => (await h.sql<{ tax_warning: string | null }[]>`select tax_warning from public.catalog_state`)[0].tax_warning;
    h.catalog.objects = [tax("TAX_ADD", "GST", "ADDITIVE"), item("I_A", "Coke", [variation("V_A")], { taxIds: ["TAX_ADD"] })];
    await syncProducts();
    expect(await warning()).toMatch(/^1 item has GST added on top/);
    expect((await getAdminState(h.staff.manager)).catalog.taxWarning).toMatch(/Coke/);

    h.catalog.objects = [tax("TAX_ADD", "GST", "INCLUSIVE"), item("I_A", "Coke", [variation("V_A")], { taxIds: ["TAX_ADD"] })];
    await syncProducts();
    expect(await warning()).toBeNull();
  });

  it("the floor and admin lists carry the barcode", async () => {
    h.catalog.objects = [item("I_A", "Coke", [variation("V_A", { data: { upc: "9300675024235", sku: "COKE", trackInventory: true } })])];
    await syncProducts();
    expect((await getFloor()).products[0]).toMatchObject({ id: "V_A", barcode: "9300675024235", stock: null });
    expect((await getAdminState(h.staff.manager)).catalog.products[0]).toMatchObject({ barcode: "9300675024235", sku: "COKE", tracked: true });
  });
});
