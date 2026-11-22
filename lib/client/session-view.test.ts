import { describe, expect, it } from "vitest";
import { movedFrom, sessionTableNames } from "./session-view";
import type { IntervalDTO } from "@/lib/domain/types";

let n = 0;
function at(table: string, startMin: number, endMin: number | null): IntervalDTO {
  const iso = (m: number) => new Date(Date.UTC(2026, 10, 20, 9, m)).toISOString();
  n += 1;
  return { id: `i${n}`, tableId: `id-${table}`, tableName: table, startedAt: iso(startMin), endedAt: endMin === null ? null : iso(endMin) };
}

describe("sessionTableNames", () => {
  it("lists tables in the order they were used", () => {
    expect(sessionTableNames({ intervals: [at("Table 2", 0, 10), at("Table 5", 10, null)] })).toBe("Table 2 → Table 5");
  });

  it("does not repeat a table after a pause or a keep playing", () => {
    expect(sessionTableNames({ intervals: [at("Table 2", 0, 10), at("Table 2", 15, null)] })).toBe("Table 2");
  });

  it("orders by start time even if the list arrives shuffled", () => {
    expect(sessionTableNames({ intervals: [at("Table 5", 10, null), at("Table 2", 0, 10)] })).toBe("Table 2 → Table 5");
  });
});

describe("movedFrom", () => {
  it("is null on a bill that has only been on one table", () => {
    expect(movedFrom({ intervals: [at("Table 3", 0, null)] })).toBeNull();
    expect(movedFrom({ intervals: [at("Table 3", 0, 10), at("Table 3", 20, null)] })).toBeNull();
    expect(movedFrom({ intervals: [] })).toBeNull();
  });

  it("names the table it came from", () => {
    expect(movedFrom({ intervals: [at("Table 3", 0, 10), at("Table 5", 10, null)] })).toBe("Moved from Table 3");
  });

  it("names the one just before the current table after several moves", () => {
    expect(movedFrom({ intervals: [at("Table 3", 0, 10), at("Table 5", 10, 20), at("Table 7", 20, null)] })).toBe("Moved from Table 5");
  });

  it("names the other table when it went back to where it started", () => {
    expect(movedFrom({ intervals: [at("Table 3", 0, 10), at("Table 5", 10, 20), at("Table 3", 20, null)] })).toBe("Moved from Table 5");
  });
});
