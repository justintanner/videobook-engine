import { describe, expect, it } from "vitest";

import {
  assertOrderKey,
  initialOrderKeys,
  isOrderKey,
  orderKeyAfter,
  orderKeyBetween,
  reconcileOrderKeys,
} from "../src/order-keys.js";

/** Deterministic PRNG so the randomized walk is reproducible. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("fractional order keys", () => {
  it("mints well-known boundary keys", () => {
    expect(orderKeyBetween(null, null)).toBe("a0");
    expect(orderKeyAfter(null)).toBe("a0");
    expect(orderKeyAfter("a0")).toBe("a1");
    expect(orderKeyBetween("a0", null)).toBe("a1");
    expect(orderKeyBetween(null, "a0")).toBe("Zz");
    expect(orderKeyBetween(null, "Zz")).toBe("Zy");
    expect(orderKeyBetween("a0", "a1")).toBe("a0V");
    expect(orderKeyBetween("a0V", "a1")).toBe("a0W");
  });

  it("keeps every generated key strictly between its neighbors", () => {
    const random = lcg(42);
    const ids: string[] = ["row-0"];
    const keys = new Map<string, string>([["row-0", "a0"]]);
    let counter = 1;
    for (let step = 0; step < 500; step += 1) {
      const id = `row-${counter}`;
      counter += 1;
      const index = Math.floor(random() * (ids.length + 1));
      const before = index > 0 ? keys.get(ids[index - 1]!)! : null;
      const after = index < ids.length ? keys.get(ids[index]!)! : null;
      const key = orderKeyBetween(before, after);
      expect(isOrderKey(key)).toBe(true);
      if (before !== null) expect(key > before).toBe(true);
      if (after !== null) expect(key < after).toBe(true);
      keys.set(id, key);
      ids.splice(index, 0, id);
    }
    const sorted = [...ids].sort((left, right) =>
      keys.get(left)! < keys.get(right)! ? -1 : 1);
    expect(sorted).toEqual(ids);
  });

  it("supports long descending chains before the first key", () => {
    let key = "a0";
    const chain = [key];
    for (let index = 0; index < 100; index += 1) {
      key = orderKeyBetween(null, key);
      expect(isOrderKey(key)).toBe(true);
      chain.unshift(key);
    }
    const sorted = [...chain].sort();
    expect(sorted).toEqual(chain);
  });

  it("validates key shape and ordering", () => {
    expect(isOrderKey("a0")).toBe(true);
    expect(isOrderKey("Zz")).toBe(true);
    expect(isOrderKey("a0V")).toBe(true);
    expect(isOrderKey("")).toBe(false);
    expect(isOrderKey("0a")).toBe(false);
    expect(isOrderKey("a0v0")).toBe(false);
    expect(isOrderKey("a")).toBe(false);
    expect(isOrderKey("a0!")).toBe(false);
    expect(() => orderKeyBetween("a1", "a0")).toThrow(/out of order/);
    expect(() => orderKeyBetween("a0", "a0")).toThrow(/out of order/);
    expect(() => orderKeyBetween("nope", null)).toThrow(/not a valid order key/);
    expect(() => assertOrderKey("", "Slot key")).toThrow(/not a valid order key/);
  });

  it("mints dense initial keys", () => {
    expect(initialOrderKeys(0)).toEqual([]);
    expect(initialOrderKeys(3)).toEqual(["a0", "a1", "a2"]);
  });

  it("reconciles without rekeying rows whose relative order is unchanged", () => {
    const existing = new Map([
      ["a", "a0"],
      ["b", "a1"],
      ["c", "a2"],
    ]);
    // Append only: every existing row keeps its key.
    const appended = reconcileOrderKeys(["a", "b", "c", "d"], existing);
    expect(appended.get("a")).toBe("a0");
    expect(appended.get("b")).toBe("a1");
    expect(appended.get("c")).toBe("a2");
    expect(appended.get("d")).toBe("a3");

    // Prepend: only the new row gets a fresh key.
    const prepended = reconcileOrderKeys(["d", "a", "b", "c"], existing);
    expect(prepended.get("a")).toBe("a0");
    expect(prepended.get("b")).toBe("a1");
    expect(prepended.get("c")).toBe("a2");
    expect(prepended.get("d")! < "a0").toBe(true);

    // Insert in the middle: existing rows keep their keys.
    const inserted = reconcileOrderKeys(["a", "d", "b", "c"], existing);
    expect(inserted.get("a")).toBe("a0");
    expect(inserted.get("b")).toBe("a1");
    expect(inserted.get("c")).toBe("a2");
    const middle = inserted.get("d")!;
    expect(middle > "a0" && middle < "a1").toBe(true);
  });

  it("rekeys the minimal subset when rows are reordered", () => {
    const existing = new Map([
      ["a", "a0"],
      ["b", "a1"],
      ["c", "a2"],
    ]);
    const swapped = reconcileOrderKeys(["b", "a", "c"], existing);
    expect(swapped.get("c")).toBe("a2");
    const changed = ["a", "b"].filter((id) => swapped.get(id) !== existing.get(id));
    expect(changed).toHaveLength(1);
    const keys = ["b", "a", "c"].map((id) => swapped.get(id)!);
    expect(keys[0]! < keys[1]!).toBe(true);
    expect(keys[1]! < keys[2]!).toBe(true);

    // Removing a row never rekeys the survivors.
    const removed = reconcileOrderKeys(["a", "c"], existing);
    expect(removed.get("a")).toBe("a0");
    expect(removed.get("c")).toBe("a2");
  });

  it("survives duplicate stored keys left by a merge", () => {
    const existing = new Map([
      ["a", "a0"],
      ["b", "a0"],
      ["c", "a1"],
    ]);
    const reconciled = reconcileOrderKeys(["a", "d", "b", "c"], existing);
    const keys = ["a", "d", "b", "c"].map((id) => reconciled.get(id)!);
    for (let index = 1; index < keys.length; index += 1) {
      expect(keys[index - 1]! < keys[index]!).toBe(true);
    }
  });
});
