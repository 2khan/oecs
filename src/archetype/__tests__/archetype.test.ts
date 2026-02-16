import { describe, expect, it } from "vitest";
import { Archetype, as_archetype_id } from "../archetype";
import { as_component_id, type ComponentID } from "../../component/component";
import { create_entity_id } from "../../entity/entity";

// Helpers
const arch_id = (n: number) => as_archetype_id(n);
const comp_id = (n: number) => as_component_id(n) as ComponentID;
const entity = (index: number, gen: number = 0) => create_entity_id(index, gen);

describe("Archetype", () => {
  //=========================================================
  // Construction
  //=========================================================

  it("preserves pre-sorted signature on construction", () => {
    const sorted = [comp_id(1), comp_id(2), comp_id(3)];
    const a = new Archetype(arch_id(0), sorted);
    expect([...a.signature]).toEqual([comp_id(1), comp_id(2), comp_id(3)]);
  });

  it("freezes signature", () => {
    const a = new Archetype(arch_id(0), [comp_id(1)]);
    expect(Object.isFrozen(a.signature)).toBe(true);
  });

  it("stores ArchetypeID", () => {
    const id = arch_id(42);
    const a = new Archetype(id, []);
    expect(a.id).toBe(id);
  });

  it("handles empty signature", () => {
    const a = new Archetype(arch_id(0), []);
    expect(a.signature.length).toBe(0);
  });

  //=========================================================
  // Membership
  //=========================================================

  it("add_entity increases entity_count", () => {
    const a = new Archetype(arch_id(0), [comp_id(1)]);
    expect(a.entity_count).toBe(0);

    a.add_entity(entity(0), 0);
    expect(a.entity_count).toBe(1);

    a.add_entity(entity(1), 1);
    expect(a.entity_count).toBe(2);
  });

  it("entity_list returns added entities", () => {
    const a = new Archetype(arch_id(0), []);
    const e0 = entity(0);
    const e1 = entity(1);
    a.add_entity(e0, 0);
    a.add_entity(e1, 1);

    expect(a.entity_list).toContain(e0);
    expect(a.entity_list).toContain(e1);
  });

  it("has_entity returns true for present entities", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(5), 5);
    expect(a.has_entity(5)).toBe(true);
    expect(a.has_entity(6)).toBe(false);
  });

  //=========================================================
  // Removal (swap-and-pop)
  //=========================================================

  it("remove_entity decreases count", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(0), 0);
    a.add_entity(entity(1), 1);
    a.remove_entity(0);
    expect(a.entity_count).toBe(1);
  });

  it("remove_entity returns swapped entity_index", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(10), 10);
    a.add_entity(entity(20), 20);
    a.add_entity(entity(30), 30);

    // Remove first (index 10) - last (index 30) should swap in
    const swapped = a.remove_entity(10);
    expect(swapped).toBe(30);
    expect(a.entity_count).toBe(2);
    expect(a.has_entity(10)).toBe(false);
    expect(a.has_entity(20)).toBe(true);
    expect(a.has_entity(30)).toBe(true);
  });

  it("remove_entity returns -1 when removing last element", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(0), 0);

    const swapped = a.remove_entity(0);
    expect(swapped).toBe(-1);
    expect(a.entity_count).toBe(0);
  });

  it("remove_entity returns -1 when removing the tail element", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(0), 0);
    a.add_entity(entity(1), 1);

    // Remove last added (tail) - no swap needed
    const swapped = a.remove_entity(1);
    expect(swapped).toBe(-1);
    expect(a.entity_count).toBe(1);
    expect(a.has_entity(0)).toBe(true);
  });

  it("can add after remove", () => {
    const a = new Archetype(arch_id(0), []);
    a.add_entity(entity(0), 0);
    a.remove_entity(0);
    expect(a.entity_count).toBe(0);

    a.add_entity(entity(1), 1);
    expect(a.entity_count).toBe(1);
    expect(a.has_entity(1)).toBe(true);
  });

  //=========================================================
  // has_component
  //=========================================================

  it("has_component returns true for components in signature", () => {
    const a = new Archetype(arch_id(0), [comp_id(2), comp_id(5), comp_id(8)]);
    expect(a.has_component(comp_id(2))).toBe(true);
    expect(a.has_component(comp_id(5))).toBe(true);
    expect(a.has_component(comp_id(8))).toBe(true);
  });

  it("has_component returns false for absent components", () => {
    const a = new Archetype(arch_id(0), [comp_id(2), comp_id(5)]);
    expect(a.has_component(comp_id(0))).toBe(false);
    expect(a.has_component(comp_id(3))).toBe(false);
    expect(a.has_component(comp_id(99))).toBe(false);
  });

  it("has_component returns false on empty signature", () => {
    const a = new Archetype(arch_id(0), []);
    expect(a.has_component(comp_id(0))).toBe(false);
  });

  //=========================================================
  // matches
  //=========================================================

  it("matches returns true for subset of signature", () => {
    const a = new Archetype(arch_id(0), [comp_id(1), comp_id(2), comp_id(3)]);
    expect(a.matches([comp_id(1), comp_id(3)])).toBe(true);
  });

  it("matches returns true for exact signature", () => {
    const a = new Archetype(arch_id(0), [comp_id(1), comp_id(2)]);
    expect(a.matches([comp_id(1), comp_id(2)])).toBe(true);
  });

  it("matches returns false when missing a required component", () => {
    const a = new Archetype(arch_id(0), [comp_id(1)]);
    expect(a.matches([comp_id(1), comp_id(2)])).toBe(false);
  });

  it("empty required matches everything", () => {
    const a = new Archetype(arch_id(0), [comp_id(1), comp_id(2)]);
    expect(a.matches([])).toBe(true);
  });

  it("empty signature only matches empty required", () => {
    const a = new Archetype(arch_id(0), []);
    expect(a.matches([])).toBe(true);
    expect(a.matches([comp_id(1)])).toBe(false);
  });

  //=========================================================
  // Graph edges
  //=========================================================

  it("get_edge returns undefined for uncached component", () => {
    const a = new Archetype(arch_id(0), []);
    expect(a.get_edge(comp_id(1))).toBeUndefined();
  });

  it("set_edge / get_edge round-trips", () => {
    const a = new Archetype(arch_id(0), []);
    const edge = { add: arch_id(1), remove: null };
    a.set_edge(comp_id(5), edge);

    const retrieved = a.get_edge(comp_id(5));
    expect(retrieved).toBe(edge);
    expect(retrieved!.add).toBe(arch_id(1));
    expect(retrieved!.remove).toBeNull();
  });
});
