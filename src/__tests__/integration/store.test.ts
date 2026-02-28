import { describe, expect, it } from "vitest";
import { Store } from "../../store";

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

describe("Store (integration)", () => {
  //=========================================================
  // Multiple component transitions
  //=========================================================

  it("adding multiple components transitions through archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const id = store.create_entity();

    store.add_component(id, Pos, { x: 1, y: 2, z: 3 });
    expect(store.has_component(id, Pos)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(false);

    store.add_component(id, Vel, { vx: 4, vy: 5, vz: 6 });
    expect(store.has_component(id, Pos)).toBe(true);
    expect(store.has_component(id, Vel)).toBe(true);

    // Verify data survived the transition
    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(1);
    expect(arch.read_field(row, Vel as ComponentID, "vx")).toBe(4);
  });

  //=========================================================
  // Independent entities
  //=========================================================

  it("different entities can have different component sets", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 1, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 1, vy: 0, vz: 0 });

    store.add_component(e2, Pos, { x: 2, y: 0, z: 0 });
    store.add_component(e2, Hp, { current: 100, max: 100 });

    expect(store.has_component(e1, Pos)).toBe(true);
    expect(store.has_component(e1, Vel)).toBe(true);
    expect(store.has_component(e1, Hp)).toBe(false);

    expect(store.has_component(e2, Pos)).toBe(true);
    expect(store.has_component(e2, Vel)).toBe(false);
    expect(store.has_component(e2, Hp)).toBe(true);
  });

  //=========================================================
  // Data preservation across transitions
  //=========================================================

  it("data is preserved when transitioning between archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const id = store.create_entity();
    store.add_component(id, Pos, { x: 10, y: 20, z: 30 });

    // Transition: [Pos] → [Pos, Vel]
    store.add_component(id, Vel, { vx: 1, vy: 2, vz: 3 });

    const arch = store.get_entity_archetype(id);
    const row = store.get_entity_row(id);

    // Pos data survived the transition
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(10);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(20);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(30);

    // Vel data is correct
    expect(arch.read_field(row, Vel as ComponentID, "vx")).toBe(1);
    expect(arch.read_field(row, Vel as ComponentID, "vy")).toBe(2);
    expect(arch.read_field(row, Vel as ComponentID, "vz")).toBe(3);
  });

  //=========================================================
  // Dense column iteration
  //=========================================================

  it("dense column iteration after multiple entities added", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const ids = [];
    for (let i = 0; i < 10; i++) {
      const id = store.create_entity();
      store.add_component(id, Pos, { x: i, y: i * 2, z: i * 3 });
      ids.push(id);
    }

    // All entities should be in the same archetype
    const archetypes = store.get_matching_archetypes(
      make_mask(Pos as ComponentID),
    );
    expect(archetypes.length).toBe(1);
    const arch = archetypes[0];
    expect(arch.entity_count).toBe(10);

    // Dense iteration should work
    const col_x = arch.get_column(Pos, "x");
    const col_y = arch.get_column(Pos, "y");
    for (let row = 0; row < arch.entity_count; row++) {
      // Rows are assigned in order, so row i has entity i
      expect(col_x[row]).toBe(row);
      expect(col_y[row]).toBe(row * 2);
    }
  });

  //=========================================================
  // Archetype deduplication
  //=========================================================

  it("same component set reuses the same archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);

    const e1 = store.create_entity();
    const e2 = store.create_entity();

    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0, vz: 0 });

    const arch_count_after_e1 = store.archetype_count;

    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e2, Vel, { vx: 0, vy: 0, vz: 0 });

    // No new archetypes should have been created
    expect(store.archetype_count).toBe(arch_count_after_e1);
  });

  //=========================================================
  // Graph edge caching
  //=========================================================

  it("second transition reuses cached edge (no new archetype)", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    const count_after_first = store.archetype_count;

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    expect(store.archetype_count).toBe(count_after_first);
  });

  //=========================================================
  // Query matching
  //=========================================================

  it("get_matching_archetypes returns archetypes with required components", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0, vz: 0 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });
    store.add_component(e2, Hp, { current: 100, max: 100 });

    // Query for [Pos] - 3 archetypes match: [Pos] (intermediate, created during
    // e1's first add_component), [Pos, Vel], and [Pos, Hp].
    const pos_matches = store.get_matching_archetypes(
      make_mask(Pos as ComponentID),
    );
    expect(pos_matches.length).toBe(3);

    // Both entities are found across matching archetypes
    const all_entities = pos_matches.flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);

    // Query for [Pos, Vel] - only e1's archetype matches
    const pos_vel_matches = store.get_matching_archetypes(
      make_mask(Pos as ComponentID, Vel as ComponentID),
    );
    expect(pos_vel_matches.length).toBe(1);
    expect(pos_vel_matches[0].entity_list).toContain(e1);

    // Query for [Hp] - only e2's archetype matches
    const hp_matches = store.get_matching_archetypes(
      make_mask(Hp as ComponentID),
    );
    expect(hp_matches.length).toBe(1);
    expect(hp_matches[0].entity_list).toContain(e2);
  });

  it("get_matching_archetypes returns empty for unregistered component combo", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp = store.register_component(Health);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0, z: 0 });

    // No entity has Vel + Hp
    const matches = store.get_matching_archetypes(
      make_mask(Vel as ComponentID, Hp as ComponentID),
    );
    expect(matches.length).toBe(0);
  });

  it("get_matching_archetypes with empty required returns all archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    store.create_entity(); // alive but has no archetype row yet
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0, z: 0 });

    const matches = store.get_matching_archetypes(make_mask());
    expect(matches.length).toBe(store.archetype_count);
  });

  //=========================================================
  // Destroy cleanup
  //=========================================================

  it("destroyed entity is removed from its archetype membership", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    const e2 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 0, z: 0 });
    store.add_component(e2, Pos, { x: 2, y: 0, z: 0 });

    const archetypes = store.get_matching_archetypes(
      make_mask(Pos as ComponentID),
    );
    expect(archetypes.length).toBe(1);
    expect(archetypes[0].entity_count).toBe(2);

    store.destroy_entity(e1);
    expect(archetypes[0].entity_count).toBe(1);
    expect(archetypes[0].entity_list).toContain(e2);
  });

  it("destroy_entity handles swap-and-pop for remaining entity data", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    const e2 = store.create_entity();
    store.add_component(e1, Pos, { x: 10, y: 20, z: 30 });
    store.add_component(e2, Pos, { x: 100, y: 200, z: 300 });

    // Destroy e1 — e2 should swap into row 0
    store.destroy_entity(e1);

    const arch = store.get_entity_archetype(e2);
    const row = store.get_entity_row(e2);
    expect(arch.read_field(row, Pos as ComponentID, "x")).toBe(100);
    expect(arch.read_field(row, Pos as ComponentID, "y")).toBe(200);
    expect(arch.read_field(row, Pos as ComponentID, "z")).toBe(300);
  });

  //=========================================================
  // Swap-and-pop with multiple entities
  //=========================================================

  it("destroying one entity preserves other entities' data in same archetype", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const e1 = store.create_entity();
    const e2 = store.create_entity();
    const e3 = store.create_entity();

    store.add_component(e1, Pos, { x: 1, y: 1, z: 1 });
    store.add_component(e2, Pos, { x: 2, y: 2, z: 2 });
    store.add_component(e3, Pos, { x: 3, y: 3, z: 3 });

    // Destroy middle entity
    store.destroy_entity(e2);

    // Remaining entities should still have correct data
    const arch1 = store.get_entity_archetype(e1);
    const row1 = store.get_entity_row(e1);
    expect(arch1.read_field(row1, Pos as ComponentID, "x")).toBe(1);

    const arch3 = store.get_entity_archetype(e3);
    const row3 = store.get_entity_row(e3);
    expect(arch3.read_field(row3, Pos as ComponentID, "x")).toBe(3);
  });

  //=========================================================
  // Capacity growth
  //=========================================================

  it("handles many entities beyond initial capacity", () => {
    const store = new Store();
    const Pos = store.register_component(Position);

    const ids = [];
    for (let i = 0; i < 200; i++) {
      const id = store.create_entity();
      store.add_component(id, Pos, { x: i, y: 0, z: 0 });
      ids.push(id);
    }

    expect(store.entity_count).toBe(200);

    for (const id of ids) {
      expect(store.is_alive(id)).toBe(true);
      expect(store.has_component(id, Pos)).toBe(true);
    }
  });
});
