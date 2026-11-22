/** Test-only builders for DTOs. Not imported by any screen. */
import type { SessionDTO, SessionItemDTO } from "@/lib/domain/types";

export function makeItem(over: Partial<SessionItemDTO> = {}): SessionItemDTO {
  return {
    id: "item-1",
    kind: "product",
    productId: "prod-1",
    name: "Chips",
    unitCents: 500,
    quantity: 1,
    taxed: true,
    addedAt: "2026-11-20T10:00:00.000Z",
    addedByName: "Sam",
    removedAt: null,
    removedByName: null,
    ...over,
  };
}

export function makeSession(over: Partial<SessionDTO> = {}): SessionDTO {
  return {
    id: "s-1",
    kind: "table",
    label: "Table 1",
    status: "awaiting_payment",
    currentTableId: "t-1",
    customerName: null,
    openedAt: "2026-11-20T09:00:00.000Z",
    openedByName: "Sam",
    closedAt: "2026-11-20T10:00:00.000Z",
    billedMinutes: 60,
    totalCents: 2500,
    discount: null,
    splitOfId: null,
    splitOffCents: 0,
    parts: [],
    refundedCents: 0,
    refundable: null,
    canPrintReceipt: false,
    itemsCents: 0,
    items: [],
    settledMethod: null,
    settledVia: null,
    settledAt: null,
    settledByName: null,
    settledCents: null,
    squareCash: null,
    voidReason: null,
    note: null,
    intervals: [
      { id: "i-1", tableId: "t-1", tableName: "Table 1", startedAt: "2026-11-20T09:00:00.000Z", endedAt: "2026-11-20T10:00:00.000Z" },
    ],
    checkout: null,
    ...over,
  };
}
