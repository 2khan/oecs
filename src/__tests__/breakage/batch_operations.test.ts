import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

describe("Batch operation edge cases", () => {
  it("batch_add to empty archetype — no crash", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    // Create an entity with Pos to create the [Pos] archetype, then remove it
    // to leave the archetype empty
    const temp = world.create_entity();
    world.add_component(temp, Pos, { x: 0, y: 0 });

    // Get the archetype reference
    const q = world.query(Pos);
    const arch = q.archetypes[0];

    // Destroy the entity to empty the archetype
    world.destroy_entity_deferred(temp);
    world.flush();

    expect(arch.entity_count).toBe(0);

    // batch_add on empty archetype should not crash (no-op)
    expect(() => {
      world.batch_add_component(arch, Vel, { vx: 1, vy: 2 });
    }).not.toThrow();

    // Archetype should still be empty (no entities to move)
    expect(arch.entity_count).toBe(0);
  });

  it("batch_add when component already present — no-op / correct behavior", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 10, y: 20 });
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 30, y: 40 });

    const q = world.query(Pos);
    const arch = q.archetypes[0];

    // batch_add Pos when entities already have Pos — should be a no-op
    expect(() => {
      world.batch_add_component(arch, Pos, { x: 99, y: 99 });
    }).not.toThrow();

    // Original values should be unchanged
    expect(world.get_field(e1, Pos, "x")).toBe(10);
    expect(world.get_field(e1, Pos, "y")).toBe(20);
    expect(world.get_field(e2, Pos, "x")).toBe(30);
    expect(world.get_field(e2, Pos, "y")).toBe(40);
  });

  it("batch_add then query — target archetype appears in query", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    // Create entities with only Pos
    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 2 });
      entities.push(e);
    }

    const posVelQuery = world.query(Pos, Vel);
    expect(posVelQuery.count()).toBe(0);

    // batch_add Vel to all entities in the Pos archetype
    const posQuery = world.query(Pos);
    const srcArch = posQuery.archetypes[0];
    world.batch_add_component(srcArch, Vel, { vx: 100, vy: 200 });

    // Now the Pos+Vel query should contain all 5 entities
    expect(posVelQuery.count()).toBe(5);

    // Verify data integrity
    for (const e of entities) {
      expect(world.has_component(e, Vel)).toBe(true);
      expect(world.get_field(e, Vel, "vx")).toBe(100);
      expect(world.get_field(e, Vel, "vy")).toBe(200);
      // Pos values should be preserved
      expect(world.has_component(e, Pos)).toBe(true);
    }

    // Verify Pos data preserved after transition
    for (let i = 0; i < entities.length; i++) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 2);
    }
  });

  it("batch_remove from archetype with 1 entity — entity moves correctly", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 5, y: 10 });
    world.add_component(e, Vel, { vx: 15, vy: 20 });

    const posVelQuery = world.query(Pos, Vel);
    expect(posVelQuery.count()).toBe(1);

    // Get the source archetype and batch_remove Vel
    const srcArch = posVelQuery.archetypes[0];
    world.batch_remove_component(srcArch, Vel);

    // Entity should no longer be in Pos+Vel query
    expect(posVelQuery.count()).toBe(0);

    // Entity should still be alive and have Pos
    expect(world.is_alive(e)).toBe(true);
    expect(world.has_component(e, Pos)).toBe(true);
    expect(world.has_component(e, Vel)).toBe(false);

    // Pos values should be preserved
    expect(world.get_field(e, Pos, "x")).toBe(5);
    expect(world.get_field(e, Pos, "y")).toBe(10);
  });

  it("batch_add then destroy one entity from target — remaining data correct (swap-and-pop)", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    // Create 5 entities with Pos
    const entities: EntityID[] = [];
    for (let i = 0; i < 5; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i * 10, y: i * 100 });
      entities.push(e);
    }

    // batch_add Tag to all
    const srcArch = world.query(Pos).archetypes[0];
    world.batch_add_component(srcArch, Tag);

    // All entities should now have both Pos and Tag
    for (const e of entities) {
      expect(world.has_component(e, Tag)).toBe(true);
    }

    // Destroy the middle entity (index 2) using deferred + flush
    world.destroy_entity_deferred(entities[2]);
    world.flush();

    expect(world.is_alive(entities[2])).toBe(false);
    expect(world.entity_count).toBe(4);

    // Remaining entities should have correct Pos data (swap-and-pop may reorder)
    const survivors = [entities[0], entities[1], entities[3], entities[4]];
    const expectedX = [0, 10, 30, 40];
    const expectedY = [0, 100, 300, 400];

    for (let i = 0; i < survivors.length; i++) {
      expect(world.is_alive(survivors[i])).toBe(true);
      expect(world.get_field(survivors[i], Pos, "x")).toBe(expectedX[i]);
      expect(world.get_field(survivors[i], Pos, "y")).toBe(expectedY[i]);
      expect(world.has_component(survivors[i], Tag)).toBe(true);
    }
  });

  it("interleave batch_add and individual add_component — final state correct", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);
    const Hp = world.register_component(["hp"] as const);

    // Create 3 entities with Pos
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 3, y: 4 });
    const e3 = world.create_entity();
    world.add_component(e3, Pos, { x: 5, y: 6 });

    // Individually add Vel to e1
    world.add_component(e1, Vel, { vx: 10, vy: 20 });

    // Now batch_add Hp to all entities that are still in the Pos-only archetype (e2, e3)
    // We need the archetype that has only Pos (not Pos+Vel)
    const posOnlyQuery = world.query(Pos).not(Vel);
    if (posOnlyQuery.archetype_count > 0) {
      const posOnlyArch = posOnlyQuery.archetypes[0];
      world.batch_add_component(posOnlyArch, Hp, { hp: 50 });
    }

    // e1: Pos + Vel (no Hp)
    expect(world.has_component(e1, Pos)).toBe(true);
    expect(world.has_component(e1, Vel)).toBe(true);
    expect(world.has_component(e1, Hp)).toBe(false);
    expect(world.get_field(e1, Pos, "x")).toBe(1);
    expect(world.get_field(e1, Vel, "vx")).toBe(10);

    // e2: Pos + Hp (no Vel)
    expect(world.has_component(e2, Pos)).toBe(true);
    expect(world.has_component(e2, Vel)).toBe(false);
    expect(world.has_component(e2, Hp)).toBe(true);
    expect(world.get_field(e2, Pos, "x")).toBe(3);
    expect(world.get_field(e2, Hp, "hp")).toBe(50);

    // e3: Pos + Hp (no Vel)
    expect(world.has_component(e3, Pos)).toBe(true);
    expect(world.has_component(e3, Vel)).toBe(false);
    expect(world.has_component(e3, Hp)).toBe(true);
    expect(world.get_field(e3, Pos, "x")).toBe(5);
    expect(world.get_field(e3, Hp, "hp")).toBe(50);
  });
});
