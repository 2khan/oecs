import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";

describe("Structural changes mid-system are properly deferred", () => {
  it("system adds component to entity it is iterating — does not appear until next update", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const posVelQuery = world.query(Pos, Vel);
    let countDuringSystem = -1;

    const sys = world.register_system(
      (q, ctx) => {
        // Iterate over Pos-only entities and add Vel to one
        for (const arch of q) {
          for (let i = 0; i < arch.entity_count; i++) {
            const eid = arch.entity_list[i] as EntityID;
            ctx.add_component(eid, Vel, { vx: 10, vy: 20 });
          }
        }
        // Pos+Vel query should still be empty during this system
        countDuringSystem = posVelQuery.archetype_count;
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // During the system, entity was not yet in Pos+Vel query
    expect(countDuringSystem).toBe(0);

    // After flush (update completes), entity is now in Pos+Vel query
    expect(posVelQuery.archetype_count).toBe(1);
    expect(world.get_field(e, Vel, "vx")).toBe(10);
    expect(world.get_field(e, Vel, "vy")).toBe(20);
  });

  it("system removes component during iteration — columns remain accessible for rest of loop", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Vel, { vx: 7, vy: 8 });

    const valuesRead: number[] = [];

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          const px = arch.get_column(Pos, "x");
          const vx = arch.get_column(Vel, "vx");
          for (let i = 0; i < arch.entity_count; i++) {
            // Remove Vel from first entity mid-iteration
            if (i === 0) {
              ctx.remove_component(arch.entity_list[i] as EntityID, Vel);
            }
            // All columns should remain valid for the entire loop
            valuesRead.push(px[i], vx[i]);
          }
        }
      },
      (qb) => qb.every(Pos, Vel),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Should have read 2 entities worth of data without crash
    expect(valuesRead.length).toBe(4);
    // All values should be numbers (no undefined / NaN from invalidated columns)
    for (const v of valuesRead) {
      expect(typeof v).toBe("number");
      expect(Number.isNaN(v)).toBe(false);
    }
  });

  it("system adds component to entity A while iterating entity B in same archetype — no corruption", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    const eA = world.create_entity();
    world.add_component(eA, Pos, { x: 100, y: 200 });

    const eB = world.create_entity();
    world.add_component(eB, Pos, { x: 300, y: 400 });

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          for (let i = 0; i < arch.entity_count; i++) {
            const eid = arch.entity_list[i];
            // When iterating eB, add Tag to eA
            if (eid === eB) {
              ctx.add_component(eA, Tag);
            }
          }
        }
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // After flush, eA should have the Tag
    expect(world.has_component(eA, Tag)).toBe(true);
    // Both entities should still be alive and have Pos with correct values
    expect(world.is_alive(eA)).toBe(true);
    expect(world.is_alive(eB)).toBe(true);
    expect(world.get_field(eA, Pos, "x")).toBe(100);
    expect(world.get_field(eA, Pos, "y")).toBe(200);
    expect(world.get_field(eB, Pos, "x")).toBe(300);
    expect(world.get_field(eB, Pos, "y")).toBe(400);
  });

  it("system adds same component to 100 entities during one tick — all transition after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const entities: EntityID[] = [];
    for (let i = 0; i < 100; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
      entities.push(e);
    }

    const posVelQuery = world.query(Pos, Vel);

    const sys = world.register_system(
      (q, ctx) => {
        for (const arch of q) {
          for (let i = 0; i < arch.entity_count; i++) {
            const eid = arch.entity_list[i] as EntityID;
            ctx.add_component(eid, Vel, { vx: 1, vy: 2 });
          }
        }
      },
      (qb) => qb.every(Pos),
    );

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // After flush, all 100 entities should be in the Pos+Vel query
    let total = 0;
    for (const arch of posVelQuery) {
      total += arch.entity_count;
    }
    expect(total).toBe(100);

    // Verify field values survived the transition
    for (const e of entities) {
      expect(world.has_component(e, Vel)).toBe(true);
      expect(world.get_field(e, Vel, "vx")).toBe(1);
      expect(world.get_field(e, Vel, "vy")).toBe(2);
    }
  });

  it("chain of 3 systems: sys1 adds C, sys2+sys3 query C — should NOT find it until next update", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Marker = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    let sys2CountDuring = -1;
    let sys3CountDuring = -1;

    // sys1: adds Marker to entity
    const sys1 = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Marker);
      },
    });

    // sys2: queries for Marker — should NOT find entity this frame
    const markerQuery = world.query(Marker);
    const sys2 = world.register_system({
      fn() {
        sys2CountDuring = markerQuery.count();
      },
    });

    // sys3: also queries Marker
    const sys3 = world.register_system({
      fn() {
        sys3CountDuring = markerQuery.count();
      },
    });

    // All in same UPDATE phase, so flush happens after all 3 run
    world.add_systems(SCHEDULE.UPDATE, sys1, sys2, sys3);
    world.startup();
    world.update(0);

    // During the update frame, sys2 and sys3 should not have seen the Marker entity
    expect(sys2CountDuring).toBe(0);
    expect(sys3CountDuring).toBe(0);

    // After flush, Marker is present
    expect(world.has_component(e, Marker)).toBe(true);

    // On the NEXT update, sys2 and sys3 should see it
    world.update(0);
    expect(sys2CountDuring).toBe(1);
    expect(sys3CountDuring).toBe(1);
  });

  it("system creates 100 new entities with components during execution — all correct after update", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const createdEntities: EntityID[] = [];
    const initialCount = world.entity_count;

    const sys = world.register_system({
      fn(ctx) {
        for (let i = 0; i < 100; i++) {
          const e = ctx.create_entity();
          ctx.add_component(e, Pos, { x: i, y: i * 2 });
          createdEntities.push(e);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // All 100 entities should exist
    expect(world.entity_count).toBe(initialCount + 100);

    // All should be alive and have correct Pos values
    for (let i = 0; i < 100; i++) {
      const e = createdEntities[i];
      expect(world.is_alive(e)).toBe(true);
      expect(world.has_component(e, Pos)).toBe(true);
      expect(world.get_field(e, Pos, "x")).toBe(i);
      expect(world.get_field(e, Pos, "y")).toBe(i * 2);
    }
  });

  it("system adds then removes same component (both deferred) — component absent after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Marker = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const sys = world.register_system({
      fn(ctx) {
        // Both deferred: add then remove in same system
        ctx.add_component(e, Marker);
        ctx.remove_component(e, Marker);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // ECS flushes adds first, then removes — so add Marker, then remove Marker.
    // Result: entity does NOT have Marker.
    expect(world.has_component(e, Marker)).toBe(false);
    // Entity should still be alive and retain Pos
    expect(world.is_alive(e)).toBe(true);
    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.get_field(e, Pos, "x")).toBe(1);
  });
});
