import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";

/**
 * Discovery tests: designed to probe architectural weak points.
 * Each test targets a specific internal mechanism that could fail silently.
 */

// ============================================================
// 1. Column reference stability across growth
// ============================================================
describe("Column buffer invalidation", () => {
  it("get_column returns STALE TypedArray after archetype grows past capacity", () => {
    // Use small initial capacity to force reallocation quickly
    const world = new ECS({ initial_capacity: 4 });
    const Pos = world.register_component(["x", "y"] as const);

    // Seed 3 entities (under capacity=4)
    for (let i = 0; i < 3; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
    }

    // Grab column ref while capacity is 4
    const q = world.query(Pos);
    let staleX: Float64Array | null = null;
    for (const arch of q) {
      staleX = arch.get_column(Pos, "x");
    }
    expect(staleX).not.toBeNull();

    // Now add 10 more entities — forces the column to grow past 4 → 8 → 16
    for (let i = 3; i < 13; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
    }

    // Grab fresh column ref
    let freshX: Float64Array | null = null;
    for (const arch of q) {
      freshX = arch.get_column(Pos, "x");
    }

    // The underlying buffer was reallocated — old ref should be a DIFFERENT object
    expect(freshX).not.toBe(staleX);

    // The old ref still has the first 3 values (they were copied during grow)
    // but it does NOT have the new values — it's stale
    expect(staleX![0]).toBe(0);
    expect(staleX![1]).toBe(1);
    expect(staleX![2]).toBe(2);
    // Index 5 on old buffer should be 0 (or whatever was in the old allocation)
    // while fresh should have 5
    expect(freshX![5]).toBe(5);

    // CRITICAL: writing to stale ref does NOT affect the live data
    staleX![0] = 999;
    expect(freshX![0]).toBe(0); // live data unaffected
    expect(world.get_field(q.archetypes[0].entity_list[0] as EntityID, Pos, "x")).toBe(0);
  });

  it("ComponentRef becomes stale after entity transitions and archetype grows", () => {
    const world = new ECS({ initial_capacity: 4 });
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 42, y: 84 });

    // Create a ref for e1 in the [Pos]-only archetype
    // The ref snapshots .buf pointers at creation time
    const sys = world.register_system({
      fn(ctx) {
        const ref = ctx.ref(Pos, e1);
        // Right now, ref works
        expect(ref.x).toBe(42);

        // Now cause e1 to transition to [Pos, Vel] archetype
        // This is deferred, so ref should still work within this system
        ctx.add_component(e1, Vel, { vx: 1, vy: 2 });

        // ref should still read correctly (deferred, no transition yet)
        expect(ref.x).toBe(42);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // After flush, e1 moved to [Pos, Vel] archetype
    // If someone held onto the ref across frames, it would be stale
    expect(world.has_component(e1, Vel)).toBe(true);
    expect(world.get_field(e1, Pos, "x")).toBe(42);
  });
});

// ============================================================
// 2. Swap-and-pop correctness across many columns
// ============================================================
describe("Swap-and-pop multi-column integrity", () => {
  it("destroying entity at row 0 with 5-field component: swapped entity has ALL fields correct", () => {
    const world = new ECS();
    const Data = world.register_component(["a", "b", "c", "d", "e"] as const);

    const e0 = world.create_entity();
    world.add_component(e0, Data, { a: 10, b: 20, c: 30, d: 40, e: 50 });
    const e1 = world.create_entity();
    world.add_component(e1, Data, { a: 11, b: 21, c: 31, d: 41, e: 51 });
    const e2 = world.create_entity();
    world.add_component(e2, Data, { a: 12, b: 22, c: 32, d: 42, e: 52 });

    // Destroy e0. e2 (last) should swap into e0's row.
    world.destroy_entity_deferred(e0);
    world.flush();

    // e1 unchanged
    expect(world.get_field(e1, Data, "a")).toBe(11);
    expect(world.get_field(e1, Data, "b")).toBe(21);
    expect(world.get_field(e1, Data, "c")).toBe(31);
    expect(world.get_field(e1, Data, "d")).toBe(41);
    expect(world.get_field(e1, Data, "e")).toBe(51);

    // e2 moved rows but ALL columns must have correct data
    expect(world.get_field(e2, Data, "a")).toBe(12);
    expect(world.get_field(e2, Data, "b")).toBe(22);
    expect(world.get_field(e2, Data, "c")).toBe(32);
    expect(world.get_field(e2, Data, "d")).toBe(42);
    expect(world.get_field(e2, Data, "e")).toBe(52);
  });

  it("destroy middle entity from 5, verify remaining 4 via column iteration", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i * 100, y: i * 1000 });
      entities.push(e);
    }

    // Destroy e2 (middle). e4 (last) swaps into e2's old row.
    world.destroy_entity_deferred(entities[2]);
    world.flush();

    // Verify remaining entities via get_field (uses entity→row mapping)
    const survivors = [entities[0], entities[1], entities[3], entities[4]];
    for (const eid of survivors) {
      expect(world.is_alive(eid)).toBe(true);
    }

    // Verify via column iteration that data is dense and correct
    const q = world.query(Pos);
    const seen = new Map<number, number>(); // x → y
    for (const arch of q) {
      const cx = arch.get_column(Pos, "x");
      const cy = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        seen.set(cx[i], cy[i]);
      }
    }

    expect(seen.size).toBe(4);
    expect(seen.get(0)).toBe(0);
    expect(seen.get(100)).toBe(1000);
    expect(seen.get(300)).toBe(3000);
    expect(seen.get(400)).toBe(4000);
    // Destroyed entity's data (200, 2000) should NOT appear
    expect(seen.has(200)).toBe(false);
  });

  it("serial destruction from front: destroy e0, e1, e2 one at a time, survivors always correct", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
      entities.push(e);
    }

    // Destroy e0, flush, verify
    world.destroy_entity_deferred(entities[0]);
    world.flush();
    for (let i = 1; i < 5; i++) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 10);
    }

    // Destroy e1, flush, verify
    world.destroy_entity_deferred(entities[1]);
    world.flush();
    for (const i of [2, 3, 4]) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 10);
    }

    // Destroy e2, flush, verify
    world.destroy_entity_deferred(entities[2]);
    world.flush();
    for (const i of [3, 4]) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 10);
    }
  });
});

// ============================================================
// 3. Entity recycling and stale ID protection
// ============================================================
describe("Entity ID recycling — stale reference safety", () => {
  it("stale ID after single recycle: is_alive returns false, has_component throws in dev", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 42, y: 84 });
    const stale = e1;

    world.destroy_entity_deferred(e1);
    world.flush();

    // Create new entity — should recycle e1's index slot with bumped generation
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 999, y: 888 });

    // is_alive correctly rejects stale ID
    expect(world.is_alive(stale)).toBe(false);

    // DISCOVERY: has_component THROWS on dead entity in dev mode
    // In production (no __DEV__), it would return false.
    // This means users MUST check is_alive() before calling has_component().
    expect(() => world.has_component(stale, Pos)).toThrow("ENTITY_NOT_ALIVE");

    // e2 should have its own data, not e1's
    expect(world.is_alive(e2)).toBe(true);
    expect(world.get_field(e2, Pos, "x")).toBe(999);
  });

  it("recycling 100× on same slot: each generation rejects all previous stale IDs", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const stale_ids: EntityID[] = [];

    for (let gen = 0; gen < 100; gen++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: gen, y: gen });
      stale_ids.push(e);

      world.destroy_entity_deferred(e);
      world.flush();
    }

    // ALL 100 previous IDs should be dead
    for (const id of stale_ids) {
      expect(world.is_alive(id)).toBe(false);
    }

    // Create one more — it lives
    const final = world.create_entity();
    expect(world.is_alive(final)).toBe(true);
  });

  it("deferred ops on stale entity are silently skipped after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const sys = world.register_system({
      fn(ctx) {
        // Destroy entity and also try to add component to it
        ctx.destroy_entity(e);
        // The add is queued but the entity will be dead when flush runs
        // adds flush before destroys, so the add WILL execute (entity still alive during adds)
        ctx.add_component(e, Vel, { vx: 10, vy: 20 });
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    // Should not crash
    expect(() => world.update(0)).not.toThrow();

    // Entity should be dead after flush
    expect(world.is_alive(e)).toBe(false);
  });
});

// ============================================================
// 4. Deferred flush ordering — add-before-remove surprises
// ============================================================
describe("Deferred flush ordering edge cases", () => {
  it("remove then add same component (queue order): remove wins because adds flush first", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, Vel, { vx: 10, vy: 20 });

    // System queues: remove Vel, then add Vel with new values
    const sys = world.register_system({
      fn(ctx) {
        ctx.remove_component(e, Vel);
        ctx.add_component(e, Vel, { vx: 99, vy: 99 });
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Flush order: adds first, then removes
    // The add runs first: Vel already present → overwrites to {99,99}
    // The remove runs second: strips Vel
    // Net result: entity does NOT have Vel
    expect(world.has_component(e, Vel)).toBe(false);
    expect(world.has_component(e, Pos)).toBe(true);
  });

  it("two systems: sys1 adds C, sys2 removes C — removal wins", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    // sys1 adds Tag
    const sys1 = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Tag);
      },
    });

    // sys2 removes Tag (runs after sys1 in same phase)
    const sys2 = world.register_system({
      fn(ctx) {
        ctx.remove_component(e, Tag);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys1, sys2);
    world.startup();
    world.update(0);

    // adds flush first: entity gets Tag
    // removes flush second: entity loses Tag
    // Net: no Tag
    expect(world.has_component(e, Tag)).toBe(false);
  });

  it("double deferred add with different values: last queued values win", () => {
    const world = new ECS();
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Vel, { vx: 1, vy: 2 });
        ctx.add_component(e, Vel, { vx: 100, vy: 200 });
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(world.has_component(e, Vel)).toBe(true);
    // First add transitions entity to [Vel] with {1,2}
    // Second add: entity already has Vel → overwrites in-place to {100,200}
    expect(world.get_field(e, Vel, "vx")).toBe(100);
    expect(world.get_field(e, Vel, "vy")).toBe(200);
  });
});

// ============================================================
// 5. Rapid archetype transition chains — data survives many hops
// ============================================================
describe("Multi-hop archetype transitions", () => {
  it("entity survives 20 add transitions: data preserved at every step", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 20; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    const e = world.create_entity();

    for (let i = 0; i < 20; i++) {
      world.add_component(e, comps[i], { v: (i + 1) * 111 });

      // ALL previously-added components must still have correct values
      for (let j = 0; j <= i; j++) {
        expect(world.get_field(e, comps[j], "v")).toBe((j + 1) * 111);
      }
    }
  });

  it("add 10 components, remove odd-indexed, re-add with new values: all correct", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 10; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    const e = world.create_entity();
    for (let i = 0; i < 10; i++) {
      world.add_component(e, comps[i], { v: (i + 1) * 100 });
    }

    // Remove odd-indexed components
    for (let i = 1; i < 10; i += 2) {
      world.remove_component(e, comps[i]);
    }

    // Verify even-indexed survive, odd-indexed are gone
    for (let i = 0; i < 10; i += 2) {
      expect(world.get_field(e, comps[i], "v")).toBe((i + 1) * 100);
    }
    for (let i = 1; i < 10; i += 2) {
      expect(world.has_component(e, comps[i])).toBe(false);
    }

    // Re-add odd-indexed with new values
    for (let i = 1; i < 10; i += 2) {
      world.add_component(e, comps[i], { v: (i + 1) * 9999 });
    }

    // ALL components present with correct values
    for (let i = 0; i < 10; i++) {
      expect(world.has_component(e, comps[i])).toBe(true);
      if (i % 2 === 0) {
        expect(world.get_field(e, comps[i], "v")).toBe((i + 1) * 100);
      } else {
        expect(world.get_field(e, comps[i], "v")).toBe((i + 1) * 9999);
      }
    }
  });

  it("two entities interleaved transitions: each preserves own data", () => {
    const world = new ECS();
    const A = world.register_component(["v"] as const);
    const B = world.register_component(["v"] as const);
    const C = world.register_component(["v"] as const);

    const e1 = world.create_entity();
    const e2 = world.create_entity();

    // Interleave: add A to both, then B to e1, C to e2
    world.add_component(e1, A, { v: 1 });
    world.add_component(e2, A, { v: 2 });
    // e1 and e2 are in same archetype [A]

    world.add_component(e1, B, { v: 10 });
    // e1 moved to [A,B], e2 stays in [A] — but e2's row may have changed via swap-and-pop

    world.add_component(e2, C, { v: 20 });
    // e2 moved to [A,C]

    // Verify: e1 has A=1, B=10, no C
    expect(world.get_field(e1, A, "v")).toBe(1);
    expect(world.get_field(e1, B, "v")).toBe(10);
    expect(world.has_component(e1, C)).toBe(false);

    // Verify: e2 has A=2, C=20, no B
    expect(world.get_field(e2, A, "v")).toBe(2);
    expect(world.get_field(e2, C, "v")).toBe(20);
    expect(world.has_component(e2, B)).toBe(false);
  });
});

// ============================================================
// 6. Query live array + iteration during structural changes
// ============================================================
describe("Query iteration edge cases", () => {
  it("query registered before any archetypes exist: live-grows to pick up new archetypes", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag1 = world.register_tag();
    const Tag2 = world.register_tag();

    // Register query before any entities or matching archetypes
    const q = world.query(Pos);
    expect(q.archetype_count).toBe(0);

    // Create entities in distinct archetypes
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Tag1);

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });
    world.add_component(e2, Tag2);

    // Query should have grown live to include both archetypes
    // (plus potentially intermediate [Pos]-only archetypes from transitions)
    let total = 0;
    for (const arch of q) {
      total += arch.entity_count;
    }
    expect(total).toBe(2);
  });

  it("entity transitions OUT of matching archetype: query no longer yields it", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, Vel, { vx: 3, vy: 4 });

    const posVelQuery = world.query(Pos, Vel);
    expect(posVelQuery.count()).toBe(1);

    // Remove Vel — entity moves to [Pos] archetype
    world.remove_component(e, Vel);

    // The [Pos,Vel] archetype is now empty — query skips empty archetypes
    expect(posVelQuery.count()).toBe(0);

    // Re-add Vel — entity moves back
    world.add_component(e, Vel, { vx: 99, vy: 88 });
    expect(posVelQuery.count()).toBe(1);

    // Data should be the new values
    expect(world.get_field(e, Vel, "vx")).toBe(99);
    expect(world.get_field(e, Vel, "vy")).toBe(88);
    // Pos should be preserved across both transitions
    expect(world.get_field(e, Pos, "x")).toBe(1);
    expect(world.get_field(e, Pos, "y")).toBe(2);
  });

  it("entity_list from archetype reflects accurate entity IDs after swap-and-pop", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: 0 });
      entities.push(e);
    }

    // Destroy e1 (index 1). e4 swaps into e1's row.
    world.destroy_entity_deferred(entities[1]);
    world.flush();

    // entity_list should contain exactly {e0, e2, e3, e4} (in some order)
    const q = world.query(Pos);
    const listed = new Set<number>();
    for (const arch of q) {
      for (let i = 0; i < arch.entity_count; i++) {
        listed.add(arch.entity_list[i]);
      }
    }

    expect(listed.size).toBe(4);
    expect(listed.has(entities[0] as number)).toBe(true);
    expect(listed.has(entities[1] as number)).toBe(false); // destroyed
    expect(listed.has(entities[2] as number)).toBe(true);
    expect(listed.has(entities[3] as number)).toBe(true);
    expect(listed.has(entities[4] as number)).toBe(true);
  });
});

// ============================================================
// 7. Batch operations edge cases
// ============================================================
describe("Batch operations — data integrity", () => {
  it("batch_add preserves per-entity source data for shared columns", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 10; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i * 7, y: i * 13 });
      entities.push(e);
    }

    // Batch add Vel to all
    const srcArch = world.query(Pos).archetypes[0];
    world.batch_add_component(srcArch, Vel, { vx: 1, vy: 2 });

    // Each entity should have its UNIQUE Pos values preserved (not clobbered)
    for (let i = 0; i < 10; i++) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i * 7);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 13);
      // Vel should be uniform
      expect(world.get_field(entities[i], Vel, "vx")).toBe(1);
      expect(world.get_field(entities[i], Vel, "vy")).toBe(2);
    }
  });

  it("batch_remove preserves remaining component data", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 10; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 2 });
      world.add_component(e, Vel, { vx: i * 3, vy: i * 4 });
      entities.push(e);
    }

    // Batch remove Vel from all
    const srcArch = world.query(Pos, Vel).archetypes[0];
    world.batch_remove_component(srcArch, Vel);

    // Pos data should be perfectly preserved
    for (let i = 0; i < 10; i++) {
      expect(world.has_component(entities[i], Vel)).toBe(false);
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 2);
    }
  });

  it("batch_add to archetype that already has entities in target: data appended correctly", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    // Create 3 entities already in [Pos, Vel]
    const existing: EntityID[] = [];
    for (let i = 0; i < 3; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i });
      world.add_component(e, Vel, { vx: i * 10, vy: i * 10 });
      existing.push(e);
    }

    // Create 5 entities in [Pos] only
    const newcomers: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: 100 + i, y: 200 + i });
      newcomers.push(e);
    }

    // Batch add Vel to the [Pos]-only archetype
    const posOnly = world.query(Pos).not(Vel);
    const srcArch = posOnly.archetypes[0];
    world.batch_add_component(srcArch, Vel, { vx: 77, vy: 88 });

    // Existing entities should be unchanged
    for (let i = 0; i < 3; i++) {
      expect(world.get_field(existing[i], Pos, "x")).toBe(i);
      expect(world.get_field(existing[i], Vel, "vx")).toBe(i * 10);
    }

    // Newcomers should have their Pos preserved + new Vel
    for (let i = 0; i < 5; i++) {
      expect(world.get_field(newcomers[i], Pos, "x")).toBe(100 + i);
      expect(world.get_field(newcomers[i], Pos, "y")).toBe(200 + i);
      expect(world.get_field(newcomers[i], Vel, "vx")).toBe(77);
      expect(world.get_field(newcomers[i], Vel, "vy")).toBe(88);
    }

    // Total in [Pos, Vel] should be 8
    expect(world.query(Pos, Vel).count()).toBe(8);
  });
});

// ============================================================
// 8. System context: create_entity is immediate, add_component deferred
// ============================================================
describe("create_entity/add_component asymmetry in systems", () => {
  it("entity created in system exists immediately but has no components until flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const posQuery = world.query(Pos);

    let createdEntity: EntityID | null = null;
    let aliveInSystem = false;
    let inQueryDuringSystem = false;

    const sys = world.register_system({
      fn(ctx) {
        createdEntity = ctx.create_entity();
        ctx.add_component(createdEntity, Pos, { x: 42, y: 84 });

        // Entity exists immediately (create is not deferred)
        aliveInSystem = world.is_alive(createdEntity);

        // But it should NOT appear in Pos query yet (add is deferred)
        inQueryDuringSystem = posQuery.count() > 0;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(aliveInSystem).toBe(true);
    expect(inQueryDuringSystem).toBe(false);

    // After flush, entity should be in query
    expect(posQuery.count()).toBe(1);
    expect(world.get_field(createdEntity!, Pos, "x")).toBe(42);
  });

  it("multiple entities created in system, all get components after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const created: EntityID[] = [];

    const sys = world.register_system({
      fn(ctx) {
        for (let i = 0; i < 50; i++) {
          const e = ctx.create_entity();
          ctx.add_component(e, Pos, { x: i, y: i * 2 });
          created.push(e);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // All 50 should have correct data
    for (let i = 0; i < 50; i++) {
      expect(world.is_alive(created[i])).toBe(true);
      expect(world.get_field(created[i], Pos, "x")).toBe(i);
      expect(world.get_field(created[i], Pos, "y")).toBe(i * 2);
    }
  });
});

// ============================================================
// 9. Transition + swap-and-pop interaction with other entities
// ============================================================
describe("Archetype transition affects co-resident entities", () => {
  it("add_component to e0 causes swap-and-pop in source archetype: co-resident e1 data intact", () => {
    const world = new ECS();
    const A = world.register_component(["v"] as const);
    const B = world.register_component(["v"] as const);

    // e0, e1, e2 all in archetype [A]
    const e0 = world.create_entity();
    world.add_component(e0, A, { v: 100 });
    const e1 = world.create_entity();
    world.add_component(e1, A, { v: 200 });
    const e2 = world.create_entity();
    world.add_component(e2, A, { v: 300 });

    // Move e0 to [A, B] — this removes e0 from [A] via swap-and-pop
    // e2 (last) should swap into e0's old row
    world.add_component(e0, B, { v: 999 });

    // e0 has both components
    expect(world.get_field(e0, A, "v")).toBe(100);
    expect(world.get_field(e0, B, "v")).toBe(999);

    // e1 and e2 still in [A], data correct
    expect(world.get_field(e1, A, "v")).toBe(200);
    expect(world.get_field(e2, A, "v")).toBe(300);

    // Move e1 to [A, B] — e2 should swap again
    world.add_component(e1, B, { v: 888 });

    expect(world.get_field(e1, A, "v")).toBe(200);
    expect(world.get_field(e1, B, "v")).toBe(888);
    expect(world.get_field(e2, A, "v")).toBe(300); // still correct after 2nd swap
  });

  it("remove_component causes swap-and-pop in source: verify co-residents", () => {
    const world = new ECS();
    const A = world.register_component(["v"] as const);
    const B = world.register_component(["v"] as const);

    const e0 = world.create_entity();
    world.add_component(e0, A, { v: 10 });
    world.add_component(e0, B, { v: 11 });

    const e1 = world.create_entity();
    world.add_component(e1, A, { v: 20 });
    world.add_component(e1, B, { v: 21 });

    const e2 = world.create_entity();
    world.add_component(e2, A, { v: 30 });
    world.add_component(e2, B, { v: 31 });

    // Remove B from e0 — e0 moves to [A], e2 swaps into e0's row in [A,B]
    world.remove_component(e0, B);

    expect(world.get_field(e0, A, "v")).toBe(10);
    expect(world.has_component(e0, B)).toBe(false);
    expect(world.get_field(e1, A, "v")).toBe(20);
    expect(world.get_field(e1, B, "v")).toBe(21);
    expect(world.get_field(e2, A, "v")).toBe(30);
    expect(world.get_field(e2, B, "v")).toBe(31);
  });
});

// ============================================================
// 10. write_fields with partial/missing values
// ============================================================
describe("Component value edge cases", () => {
  it("overwriting component values in-place preserves other entities in same archetype", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });

    // Overwrite e1's Pos (same component, no transition)
    world.add_component(e1, Pos, { x: 99, y: 88 });

    // e1 updated, e2 untouched
    expect(world.get_field(e1, Pos, "x")).toBe(99);
    expect(world.get_field(e1, Pos, "y")).toBe(88);
    expect(world.get_field(e2, Pos, "x")).toBe(3);
    expect(world.get_field(e2, Pos, "y")).toBe(4);
  });

  it("set_field writes to correct entity even after swap-and-pop rearranges rows", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: 0 });
      entities.push(e);
    }

    // Destroy e0 — e4 swaps into row 0
    world.destroy_entity_deferred(entities[0]);
    world.flush();

    // Now use set_field on e4 (which swapped rows)
    world.set_field(entities[4], Pos, "x", 777);
    expect(world.get_field(entities[4], Pos, "x")).toBe(777);

    // Other entities unaffected
    expect(world.get_field(entities[1], Pos, "x")).toBe(1);
    expect(world.get_field(entities[2], Pos, "x")).toBe(2);
    expect(world.get_field(entities[3], Pos, "x")).toBe(3);
  });
});

// ============================================================
// 11. Deferred destroy + deferred add interaction
// ============================================================
describe("Deferred destroy + structural interaction", () => {
  it("deferred add then destroy same entity: entity is dead, no ghost data in target archetype", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    // Another entity that should survive
    const survivor = world.create_entity();
    world.add_component(survivor, Pos, { x: 10, y: 20 });
    world.add_component(survivor, Vel, { vx: 30, vy: 40 });

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Vel, { vx: 99, vy: 99 });
        ctx.destroy_entity(e);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // e is dead
    expect(world.is_alive(e)).toBe(false);

    // The [Pos, Vel] archetype should only have the survivor, not ghost data from e
    const q = world.query(Pos, Vel);
    let totalEntities = 0;
    for (const arch of q) {
      totalEntities += arch.entity_count;
      // Verify all entities in the archetype are actually alive
      for (let i = 0; i < arch.entity_count; i++) {
        expect(world.is_alive(arch.entity_list[i] as EntityID)).toBe(true);
      }
    }
    expect(totalEntities).toBe(1);
    expect(world.get_field(survivor, Vel, "vx")).toBe(30);
  });

  it("deferred destroy 500 entities while 500 survive: no cross-contamination", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const doomed: EntityID[] = [];
    const safe: EntityID[] = [];

    for (let i = 0; i < 1000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 3 });
      if (i % 2 === 0) {
        doomed.push(e);
      } else {
        safe.push(e);
      }
    }

    const sys = world.register_system({
      fn(ctx) {
        for (const e of doomed) {
          ctx.destroy_entity(e);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(world.entity_count).toBe(500);

    // Every safe entity should have its original data
    for (let i = 0; i < safe.length; i++) {
      const originalIndex = i * 2 + 1; // odd indices
      expect(world.is_alive(safe[i])).toBe(true);
      expect(world.get_field(safe[i], Pos, "x")).toBe(originalIndex);
      expect(world.get_field(safe[i], Pos, "y")).toBe(originalIndex * 3);
    }
  });
});

// ============================================================
// 12. Edge: entity with no components
// ============================================================
describe("Entity with no components", () => {
  it("entity with no components is alive, has_component returns false, not in any query", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e = world.create_entity();
    // No add_component call

    expect(world.is_alive(e)).toBe(true);
    expect(world.has_component(e, Pos)).toBe(false);

    // Query for Pos should not find this entity
    const q = world.query(Pos);
    expect(q.count()).toBe(0);
  });

  it("entity can receive components after existing with none", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e = world.create_entity();
    // Later, add a component
    world.add_component(e, Pos, { x: 42, y: 84 });

    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.get_field(e, Pos, "x")).toBe(42);
    expect(world.get_field(e, Pos, "y")).toBe(84);
  });
});
