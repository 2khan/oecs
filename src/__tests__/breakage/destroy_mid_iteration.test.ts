import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";

describe("Destruction during system execution", () => {
  it("system destroys current entity — archetype columns valid for remaining entities", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 10, y: 20 });
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 30, y: 40 });
    const e3 = world.create_entity();
    world.add_component(e3, Pos, { x: 50, y: 60 });

    const valuesRead: number[] = [];
    let destroyedEntity: EntityID | null = null;

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          const px = arch.get_column(Pos, "x");
          const py = arch.get_column(Pos, "y");
          for (let i = 0; i < arch.entity_count; i++) {
            // Destroy the first entity we encounter
            if (destroyedEntity === null) {
              destroyedEntity = arch.entity_list[i] as EntityID;
              ctx.destroy_entity(arch.entity_list[i] as EntityID);
            }
            // All reads should succeed, including after the deferred destroy call
            valuesRead.push(px[i], py[i]);
          }
        }
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Should have read all 3 entities (6 values) without crashing
    expect(valuesRead.length).toBe(6);
    for (const v of valuesRead) {
      expect(typeof v).toBe("number");
      expect(Number.isNaN(v)).toBe(false);
    }

    // The destroyed entity is now dead after flush
    expect(world.is_alive(destroyedEntity!)).toBe(false);
    // Remaining entities are still alive
    expect(world.entity_count).toBe(2);
  });

  it("system marks ALL entities for deferred destruction — iteration completes, entities dead after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 10; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
      entities.push(e);
    }

    let iterationCount = 0;

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          for (let i = 0; i < arch.entity_count; i++) {
            ctx.destroy_entity(arch.entity_list[i] as EntityID);
            iterationCount++;
          }
        }
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Should have iterated all 10 entities
    expect(iterationCount).toBe(10);

    // All entities are dead after flush
    for (const e of entities) {
      expect(world.is_alive(e)).toBe(false);
    }
    expect(world.entity_count).toBe(0);
  });

  it("interleaved create + destroy in single system — entity_count correct after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    // Create 5 initial entities
    const initial: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: 0 });
      initial.push(e);
    }

    const created: EntityID[] = [];

    const sys = world.register_system({
      fn(ctx) {
        // Destroy 3 of the initial entities
        for (let i = 0; i < 3; i++) {
          ctx.destroy_entity(initial[i]);
        }
        // Create 4 new entities
        for (let i = 0; i < 4; i++) {
          const e = ctx.create_entity();
          ctx.add_component(e, Pos, { x: 100 + i, y: 0 });
          created.push(e);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Started with 5, destroyed 3, created 4 = 6 alive
    expect(world.entity_count).toBe(6);

    // Destroyed entities are dead
    for (let i = 0; i < 3; i++) {
      expect(world.is_alive(initial[i])).toBe(false);
    }

    // Surviving initial entities are alive
    for (let i = 3; i < 5; i++) {
      expect(world.is_alive(initial[i])).toBe(true);
    }

    // Newly created entities are alive with correct data
    for (let i = 0; i < 4; i++) {
      expect(world.is_alive(created[i])).toBe(true);
      expect(world.get_field(created[i], Pos, "x")).toBe(100 + i);
    }
  });

  it("destroy in sys1, sys2 still sees entity (deferred) — dead after update completes", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 42, y: 84 });

    let sys2SawEntity = false;
    let sys2CouldReadField = false;

    // sys1 defers destruction
    const sys1 = world.register_system({
      fn(ctx) {
        ctx.destroy_entity(e);
      },
    });

    // sys2 checks if entity is still visible during same phase
    const posQuery = world.query(Pos);
    const sys2 = world.register_system({
      fn() {
        for (const arch of posQuery) {
          for (let i = 0; i < arch.entity_count; i++) {
            if (arch.entity_list[i] === e) {
              sys2SawEntity = true;
              const px = arch.get_column(Pos, "x");
              sys2CouldReadField = px[i] === 42;
            }
          }
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys1, sys2);
    world.startup();
    world.update(0);

    // sys2 should have seen the entity (destroy was deferred within the same phase)
    expect(sys2SawEntity).toBe(true);
    expect(sys2CouldReadField).toBe(true);

    // After update completes (flush), entity is dead
    expect(world.is_alive(e)).toBe(false);
  });

  it("mass deferred destruction: 1,000 entities queued, flush, verify all dead", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 1_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: 0 });
      entities.push(e);
    }

    expect(world.entity_count).toBe(1_000);

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          for (let i = 0; i < arch.entity_count; i++) {
            ctx.destroy_entity(arch.entity_list[i] as EntityID);
          }
        }
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // All 1,000 entities should be dead
    expect(world.entity_count).toBe(0);
    for (const e of entities) {
      expect(world.is_alive(e)).toBe(false);
    }
  });
});
