import { describe, expect, it } from "vitest";
import { Store } from "../../store";
import { get_entity_index } from "../../entity";

import type { ComponentID } from "../../component";
import { BitSet } from "type_primitives";

function make_mask(...ids: (number | ComponentID)[]): BitSet {
  const mask = new BitSet();
  for (const id of ids) mask.set(id as number);
  return mask;
}

// Component schemas
const Position = { x: "f64", y: "f64", z: "f64" } as const;
const Velocity = { vx: "f64", vy: "f64", vz: "f64" } as const;
const Health = { current: "f64", max: "f64" } as const;
const Tag = {} as const; // empty (marker component)

describe("Store", () => {
  //=========================================================
  // Entity lifecycle
  //=========================================================

  it("creates entities with incrementing indices", () => {
    const store = new Store();
    const a = store.create_entity();
    const b = store.create_entity();
    expect(get_entity_index(a)).toBe(0);
    expect(get_entity_index(b)).toBe(1);
  });

  it("is_alive returns true for living entities", () => {
    const store = new Store();
    const id = store.create_entity();
    expect(store.is_alive(id)).toBe(true);
  });

  it("is_alive returns false after destroy", () => {
    const store = new Store();
    const id = store.create_entity();
    store.destroy_entity(id);
    expect(store.is_alive(id)).toBe(false);
  });

  it("entity_count tracks create/destroy", () => {
    const store = new Store();
    expect(store.entity_count).toBe(0);

    const a = store.create_entity();
    const b = store.create_entity();
    expect(store.entity_count).toBe(2);

    store.destroy_entity(a);
    expect(store.entity_count).toBe(1);

    store.destroy_entity(b);
    expect(store.entity_count).toBe(0);
  });

  it("throws when destroying a dead entity", () => {
    const store = new Store();
    const id = store.create_entity();
    store.destroy_entity(id);
    expect(() => store.destroy_entity(id)).toThrow();
  });

  //=========================================================
  // Component add & archetype transitions (single)
  //=========================================================

  it("add_component transitions entity to new archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    expect(store.has_component(id, Pos)).toBe(true);

    // Data is accessible via archetype columns
    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(1);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(2);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(3);
  });

  it("add_component overwrites data without transition when component already present", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    const arch_count_before = store.archetype_count;

    store.add_component(id, Pos, { x: 10, y: 20, z: 30 });
    expect(store.archetype_count).toBe(arch_count_before);

    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(10);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(20);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(30);
  });

  //=========================================================
  // Component remove (single)
  //=========================================================

  it("remove_component transitions entity to smaller archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Vel)).toBe(true);

    store.remove_component(id, Vel);
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);

    // Position data is preserved after transition
    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(1);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(2);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(3);
  });

  it("remove_component is a no-op when component not present", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Should not throw
    store.remove_component(id, Vel);
    expect(store.has_component(id, Pos)).toBe(true);
  });

  //=========================================================
  // Deferred destruction
  //=========================================================

  it("deferred destroy keeps entity alive until flush", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity_deferred(id);
    expect(store.is_alive(id)).toBe(true);
    expect(store.pending_destroy_count).toBe(1);
  });

  it("flush_destroyed actually destroys entities", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 10, y: 20, z: 30 });

    const archetypes = store.get_matching_archetypes(
      make_mask(Pos as ComponentID),
    );
    expect(archetypes[0].entity_count).toBe(1);

    store.destroy_entity_deferred(id);
    store.flush_destroyed();

    expect(store.is_alive(id)).toBe(false);
    expect(archetypes[0].entity_count).toBe(0);
    expect(store.pending_destroy_count).toBe(0);
  });

  it("double deferred destroy of same entity is safe", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity_deferred(id);
    store.destroy_entity_deferred(id);
    expect(store.pending_destroy_count).toBe(2);

    // flush should not throw — second entry is skipped because entity is already dead
    expect(() => store.flush_destroyed()).not.toThrow();
    expect(store.is_alive(id)).toBe(false);
    expect(store.pending_destroy_count).toBe(0);
  });

  it("immediate destroy_entity still works as before", () => {
    const store = new Store();
    const id = store.create_entity();

    store.destroy_entity(id);
    expect(store.is_alive(id)).toBe(false);
    expect(store.pending_destroy_count).toBe(0);
  });

  it("pending_destroy_count reflects buffer state", () => {
    const store = new Store();
    const a = store.create_entity();
    const b = store.create_entity();

    expect(store.pending_destroy_count).toBe(0);

    store.destroy_entity_deferred(a);
    expect(store.pending_destroy_count).toBe(1);

    store.destroy_entity_deferred(b);
    expect(store.pending_destroy_count).toBe(2);

    store.flush_destroyed();
    expect(store.pending_destroy_count).toBe(0);
  });

  //=========================================================
  // Deferred structural changes
  //=========================================================

  it("add_component_deferred keeps entity in old archetype until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Deferred add — entity should NOT have Velocity yet
    store.add_component_deferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);

    // After flush, entity transitions
    store.flush_structural();
    expect(store.has_component(id, Vel)).toBe(true);
    expect(store.has_component(id, Pos)).toBe(true);

    // Data is correct
    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Vel as ComponentID, "vx")).toBe(4);
    expect(arch.read_field(row, Vel as ComponentID, "vy")).toBe(5);
    expect(arch.read_field(row, Vel as ComponentID, "vz")).toBe(6);
  });

  it("remove_component_deferred keeps component present until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });

    // Deferred remove — entity should still have Velocity
    store.remove_component_deferred(id, Vel);
    expect(store.has_component(id, Vel)).toBe(true);

    // After flush, component is removed
    store.flush_structural();
    expect(store.has_component(id, Vel)).toBe(false);
    expect(store.has_component(id, Pos)).toBe(true);
  });

  it("flush_structural applies adds then removes in order", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    // Buffer: add Vel, add Hp, remove Pos
    store.add_component_deferred(id, Vel, { vx: 1, vy: 2, vz: 3 });
    store.add_component_deferred(id, Hp, { current: 100, max: 200 });
    store.remove_component_deferred(id, Pos);

    store.flush_structural();

    // Adds applied first, then removes
    expect(store.has_component(id, Vel)).toBe(true);
    expect(store.has_component(id, Hp)).toBe(true);
    expect(store.has_component(id, Pos)).toBe(false);
  });

  it("deferred add to entity later deferred-destroyed: add applies then destroy", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });

    store.add_component_deferred(id, Vel, { vx: 4, vy: 5, vz: 6 });
    store.destroy_entity_deferred(id);

    // Flush structural first (adds apply), then destroy
    store.flush_structural();
    expect(store.is_alive(id)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(true);

    store.flush_destroyed();
    expect(store.is_alive(id)).toBe(false);
  });

  it("double deferred add of same component: last values win", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();

    store.add_component_deferred(id, Pos, { x: 1, y: 2, z: 3 });
    store.add_component_deferred(id, Pos, { x: 10, y: 20, z: 30 });

    store.flush_structural();

    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(10);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(20);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(30);
  });

  it("pending_structural_count tracks buffer state", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 0, y: 0, z: 0 });

    expect(store.pending_structural_count).toBe(0);

    store.add_component_deferred(id, Vel, { vx: 0, vy: 0, vz: 0 });
    expect(store.pending_structural_count).toBe(1);

    store.remove_component_deferred(id, Pos);
    expect(store.pending_structural_count).toBe(2);

    store.flush_structural();
    expect(store.pending_structural_count).toBe(0);
  });

  it("throws on deferred add to dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() =>
      store.add_component_deferred(id, Pos, { x: 0, y: 0, z: 0 }),
    ).toThrow();
  });

  it("throws on deferred remove from dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.remove_component_deferred(id, Pos)).toThrow();
  });

  it("flush_structural skips dead entities", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const a = store.create_entity();
    const b = store.create_entity();
    store.add_component(a, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(b, Pos, { x: 0, y: 0, z: 0 });

    store.add_component_deferred(a, Vel, { vx: 1, vy: 2, vz: 3 });
    store.add_component_deferred(b, Vel, { vx: 4, vy: 5, vz: 6 });

    // Kill entity a before flushing
    store.destroy_entity(a);

    // Should not throw — dead entity a is skipped
    expect(() => store.flush_structural()).not.toThrow();

    // b should still get its component
    expect(store.has_component(b, Vel)).toBe(true);
  });

  //=========================================================
  // Dev-mode errors
  //=========================================================

  it("throws on add_component to dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.add_component(id, Pos, { x: 0, y: 0, z: 0 })).toThrow();
  });

  it("throws on remove_component from dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.add_component(id, Pos, { x: 0, y: 0, z: 0 });
    store.destroy_entity(id);

    expect(() => store.remove_component(id, Pos)).toThrow();
  });

  it("throws on has_component for dead entity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const id = store.create_entity();
    store.destroy_entity(id);

    expect(() => store.has_component(id, Pos)).toThrow();
  });

  //=========================================================
  // add_components bulk
  //=========================================================

  it("add_components adds multiple components in single transition", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_components(id, [
      { def: Pos, values: { x: 1, y: 2, z: 3 } },
      { def: Vel, values: { vx: 4, vy: 5, vz: 6 } },
    ]);

    expect(store.has_component(id, Pos)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(true);

    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(1);
    expect(arch.read_field(row, Vel as ComponentID, "vx")).toBe(4);
  });

  //=========================================================
  // Tag components (empty schema)
  //=========================================================

  it("tag components work for archetype grouping", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Marker = store.register_component(Tag);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Marker, {});

    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });

    expect(store.has_component(e1, Marker)).toBe(true);
    expect(store.has_component(e2, Marker)).toBe(false);

    const marker_archetypes = store.get_matching_archetypes(
      make_mask(Marker as ComponentID),
    );
    expect(marker_archetypes.length).toBe(1);
    expect(marker_archetypes[0].entity_list).toContain(e1);
  });
});
