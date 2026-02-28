import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";

describe("Query cache coherence edge cases", () => {
  it("query cached before entities exist — live array picks them up when matching entities are created", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    // Cache the query before any entities exist
    const q = world.query(Pos);
    expect(q.archetype_count).toBe(0);
    expect(q.count()).toBe(0);

    // Now create matching entities
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });

    // Same query reference should now see the entities via live update
    expect(q.archetype_count).toBeGreaterThan(0);
    expect(q.count()).toBe(2);

    // Verify we can iterate and read data
    let total = 0;
    for (const arch of q) {
      total += arch.entity_count;
      const px = arch.get_column(Pos, "x");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(typeof px[i]).toBe("number");
      }
    }
    expect(total).toBe(2);
  });

  it("query -> add entities -> destroy all -> add new to same archetype — for..of correct", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const q = world.query(Pos);

    // Phase 1: create and populate
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });

    expect(q.count()).toBe(2);

    // Phase 2: destroy all via deferred + flush
    world.destroy_entity_deferred(e1);
    world.destroy_entity_deferred(e2);
    world.flush();

    // for..of should skip empty archetypes
    let countAfterDestroy = 0;
    for (const arch of q) {
      countAfterDestroy += arch.entity_count;
    }
    expect(countAfterDestroy).toBe(0);

    // Phase 3: add new entities to the same archetype shape
    const e3 = world.create_entity();
    world.add_component(e3, Pos, { x: 10, y: 20 });

    // for..of should now yield exactly the new entity
    let countAfterReadd = 0;
    const readValues: number[] = [];
    for (const arch of q) {
      countAfterReadd += arch.entity_count;
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        readValues.push(px[i], py[i]);
      }
    }
    expect(countAfterReadd).toBe(1);
    expect(readValues).toEqual([10, 20]);
  });

  it("query with .not(Tag) + add Tag during system — entity gone from query after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 5, y: 10 });

    const qNoTag = world.query(Pos).not(Tag);
    expect(qNoTag.count()).toBe(1);

    let countDuringSystem = -1;

    const sys = world.register_system({
      fn(ctx) {
        // During system, add Tag to entity
        ctx.add_component(e, Tag);
        // Query should still show the entity (deferred)
        countDuringSystem = qNoTag.count();
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // During the system, entity was still visible (deferred add)
    expect(countDuringSystem).toBe(1);

    // After flush, entity has Tag so it should no longer match .not(Tag)
    expect(qNoTag.count()).toBe(0);
    // Entity should still be alive
    expect(world.is_alive(e)).toBe(true);
    expect(world.has_component(e, Tag)).toBe(true);
  });

  it("two queries Q1=[Pos], Q2=[Pos,Vel]; remove Vel during system — entity in Q1 not Q2 after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    world.add_component(e, Vel, { vx: 3, vy: 4 });

    const q1 = world.query(Pos);       // matches [Pos] and [Pos,Vel]
    const q2 = world.query(Pos, Vel);   // matches only [Pos,Vel]

    // Before: entity is in both queries
    expect(q1.count()).toBe(1);
    expect(q2.count()).toBe(1);

    const sys = world.register_system({
      fn(ctx) {
        ctx.remove_component(e, Vel);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // After flush: entity moved from [Pos,Vel] archetype to [Pos] archetype
    // q1 should still see it (entity still has Pos)
    expect(q1.count()).toBe(1);
    // q2 should NOT see it (entity no longer has Vel)
    expect(q2.count()).toBe(0);
  });

  it("archetype empty -> re-populated — query yields exactly 1 archetype with 1 entity", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    // Create entity, populate archetype
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const q = world.query(Pos);
    expect(q.count()).toBe(1);

    // Empty it via deferred destroy + flush
    world.destroy_entity_deferred(e1);
    world.flush();
    expect(q.count()).toBe(0);

    // Repopulate with a single entity
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 99, y: 88 });

    // Query should yield exactly 1 non-empty archetype with 1 entity
    let archCount = 0;
    let totalEntities = 0;
    for (const arch of q) {
      archCount++;
      totalEntities += arch.entity_count;
    }
    expect(archCount).toBe(1);
    expect(totalEntities).toBe(1);
    expect(world.get_field(e2, Pos, "x")).toBe(99);
  });

  it("200 distinct queries in tight loop — cache size correct, no duplicates", () => {
    const world = new ECS();

    // Register 200 distinct components
    const defs = [];
    for (let i = 0; i < 200; i++) {
      defs.push(world.register_component(["v"] as const));
    }

    // Create 200 distinct single-component queries
    const queries = [];
    for (let i = 0; i < 200; i++) {
      queries.push(world.query(defs[i]));
    }

    // Each query should be a unique object
    const uniqueQueries = new Set(queries);
    expect(uniqueQueries.size).toBe(200);

    // Re-requesting the same query should return the cached instance
    for (let i = 0; i < 200; i++) {
      const again = world.query(defs[i]);
      expect(again).toBe(queries[i]);
    }
  });
});
