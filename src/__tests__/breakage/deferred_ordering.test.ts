import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { EntityID } from "../../entity";

describe("Deferred operation ordering", () => {
  it("deferred add A then add B — entity has both after flush", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const A = world.register_tag();
    const B = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, A);
        ctx.add_component(e, B);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    expect(world.has_component(e, A)).toBe(true);
    expect(world.has_component(e, B)).toBe(true);
    // Pos data should survive the transitions
    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.get_field(e, Pos, "x")).toBe(1);
    expect(world.get_field(e, Pos, "y")).toBe(2);
  });

  it("deferred add A then remove A — entity does NOT have A (add first, then remove)", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const A = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 5, y: 10 });

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, A);
        ctx.remove_component(e, A);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Flush processes all adds first, then all removes.
    // So: add A (entity transitions to [Pos, A]), then remove A (transitions back to [Pos]).
    // Result: entity does NOT have A.
    expect(world.has_component(e, A)).toBe(false);
    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.get_field(e, Pos, "x")).toBe(5);
  });

  it("multiple deferred adds of same component — last values win", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const sys = world.register_system({
      fn(ctx) {
        // Queue three adds of the same component with different values
        ctx.add_component(e, Vel, { vx: 10, vy: 20 });
        ctx.add_component(e, Vel, { vx: 30, vy: 40 });
        ctx.add_component(e, Vel, { vx: 50, vy: 60 });
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Entity should have Vel. The first add transitions the entity to [Pos,Vel],
    // subsequent adds overwrite values in-place since the component is already present.
    expect(world.has_component(e, Vel)).toBe(true);
    expect(world.get_field(e, Vel, "vx")).toBe(50);
    expect(world.get_field(e, Vel, "vy")).toBe(60);
  });

  it("deferred add + deferred destroy — structural flush applies, then destroy", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    const sys = world.register_system({
      fn(ctx) {
        ctx.add_component(e, Vel, { vx: 99, vy: 99 });
        ctx.destroy_entity(e);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Flush processes structural changes (adds/removes) first, then destructions.
    // So: entity gets Vel added, then entity is destroyed.
    // Entity should be dead after the update.
    expect(world.is_alive(e)).toBe(false);
    expect(world.entity_count).toBe(0);
  });

  it("3 systems defer different ops on same entity — operations apply in correct order", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const A = world.register_tag();
    const B = world.register_tag();
    const C = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });
    // Give entity tag A initially
    world.add_component(e, A);

    // sys1: add B
    const sys1 = world.register_system({
      fn(ctx) {
        ctx.add_component(e, B);
      },
    });

    // sys2: add C
    const sys2 = world.register_system({
      fn(ctx) {
        ctx.add_component(e, C);
      },
    });

    // sys3: remove A
    const sys3 = world.register_system({
      fn(ctx) {
        ctx.remove_component(e, A);
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys1, sys2, sys3);
    world.startup();
    world.update(0);

    // After flush: adds are processed first (add B, add C), then removes (remove A).
    // Entity should have: Pos, B, C but NOT A.
    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.has_component(e, A)).toBe(false);
    expect(world.has_component(e, B)).toBe(true);
    expect(world.has_component(e, C)).toBe(true);
    expect(world.get_field(e, Pos, "x")).toBe(1);
    expect(world.get_field(e, Pos, "y")).toBe(2);
  });

  it("stress: 500 entities each getting random deferred add or remove — all final states match expected", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    // Create 500 entities, half with Tag initially
    const entities: EntityID[] = [];
    const initialHasTag: boolean[] = [];
    for (let i = 0; i < 500; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: 0 });
      const hasTag = i % 2 === 0;
      if (hasTag) {
        world.add_component(e, Tag);
      }
      entities.push(e);
      initialHasTag.push(hasTag);
    }

    // Use a deterministic "random" pattern: toggle Tag on every 3rd entity
    const expectedHasTag = [...initialHasTag];
    const ops: Array<{ entity: EntityID; action: "add" | "remove" }> = [];

    for (let i = 0; i < 500; i++) {
      if (i % 3 === 0) {
        if (expectedHasTag[i]) {
          // Remove Tag
          ops.push({ entity: entities[i], action: "remove" });
          expectedHasTag[i] = false;
        } else {
          // Add Tag
          ops.push({ entity: entities[i], action: "add" });
          expectedHasTag[i] = true;
        }
      }
    }

    const sys = world.register_system({
      fn(ctx) {
        for (const op of ops) {
          if (op.action === "add") {
            ctx.add_component(op.entity, Tag);
          } else {
            ctx.remove_component(op.entity, Tag);
          }
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);

    // Verify all entities match expected state
    for (let i = 0; i < 500; i++) {
      expect(world.is_alive(entities[i])).toBe(true);
      expect(world.has_component(entities[i], Tag)).toBe(expectedHasTag[i]);
      // Pos data should be intact
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
    }
  });
});
