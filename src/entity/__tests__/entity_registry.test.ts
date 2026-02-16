import { describe, expect, it } from "vitest";
import { EntityRegistry, INITIAL_CAPACITY } from "../entity_registry";
import {
  create_entity_id,
  get_entity_generation,
  get_entity_index,
} from "../entity";

describe("EntityRegistry", () => {
  it("create_entities sequential indices starting at generation 0", () => {
    const reg = new EntityRegistry();
    const a = reg.create_entity();
    const b = reg.create_entity();
    const c = reg.create_entity();

    expect(get_entity_index(a)).toBe(0);
    expect(get_entity_index(b)).toBe(1);
    expect(get_entity_index(c)).toBe(2);

    expect(get_entity_generation(a)).toBe(0);
    expect(get_entity_generation(b)).toBe(0);
    expect(get_entity_generation(c)).toBe(0);
  });

  it("recycles index with bumped generation after destroy", () => {
    const reg = new EntityRegistry();
    const a = reg.create_entity(); // index 0, gen 0
    reg.destroy(a);
    const b = reg.create_entity(); // recycled index 0, gen 1

    expect(get_entity_index(b)).toBe(get_entity_index(a));
    expect(get_entity_generation(b)).toBe(get_entity_generation(a) + 1);
  });

  it("is_alive returns true for living entity", () => {
    const reg = new EntityRegistry();
    const id = reg.create_entity();
    expect(reg.is_alive(id)).toBe(true);
  });

  it("is_alive returns false for destroyed entity", () => {
    const reg = new EntityRegistry();
    const id = reg.create_entity();
    reg.destroy(id);
    expect(reg.is_alive(id)).toBe(false);
  });

  it("is_alive returns false for stale ID after index is recycled", () => {
    const reg = new EntityRegistry();
    const stale = reg.create_entity(); // index 0, gen 0
    reg.destroy(stale);
    reg.create_entity(); // index 0, gen 1

    expect(reg.is_alive(stale)).toBe(false);
  });

  it("throws when destroying the same entity twice", () => {
    const reg = new EntityRegistry();
    const id = reg.create_entity();
    reg.destroy(id);
    expect(() => reg.destroy(id)).toThrow();
  });

  it("tracks count through create_entity/destroy cycles", () => {
    const reg = new EntityRegistry();
    expect(reg.count).toBe(0);

    const a = reg.create_entity();
    const b = reg.create_entity();
    expect(reg.count).toBe(2);

    reg.destroy(a);
    expect(reg.count).toBe(1);

    reg.destroy(b);
    expect(reg.count).toBe(0);

    reg.create_entity();
    reg.create_entity();
    reg.create_entity();
    expect(reg.count).toBe(3);
  });

  //=========================================================
  // EDGE CASES
  //=========================================================
  it("grows backing buffer beyond initial capacity", () => {
    const reg = new EntityRegistry();
    const ids = [];

    for (let i = 0; i < INITIAL_CAPACITY + 100; i++) {
      ids.push(reg.create_entity());
    }

    expect(reg.count).toBe(INITIAL_CAPACITY + 100);

    for (const id of ids) {
      expect(reg.is_alive(id)).toBe(true);
    }
  });

  it("is_alive returns false for never-allocated index", () => {
    const reg = new EntityRegistry();
    // Fabricate an ID with index 999 that was never allocated
    const fake = create_entity_id(999, 0);
    expect(reg.is_alive(fake)).toBe(false);
  });
});
