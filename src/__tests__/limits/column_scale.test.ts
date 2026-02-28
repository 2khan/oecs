import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

const Position = ["x", "y"] as const;

describe("Column scale", () => {
  it("10,000 entities with Position, write unique values, verify all via column access", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    for (let i = 0; i < 10_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 3 });
    }

    for (const arch of world.query(Pos)) {
      const cx = arch.get_column(Pos, "x");
      const cy = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(cy[i]).toBe(cx[i] * 3);
      }
    }
  });

  it("5,000 entities with 3-field component, delete 2,500, verify remaining columns", () => {
    const world = new ECS();
    const Data = world.register_component(["a", "b", "c"] as const);

    const entities = [];
    for (let i = 0; i < 5_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Data, { a: i, b: i + 1, c: i + 2 });
      entities.push(e);
    }

    // Delete even-indexed entities
    for (let i = 0; i < 5_000; i += 2) {
      world.destroy_entity_deferred(entities[i]);
    }
    world.flush();

    // Verify remaining entities have correct data
    for (let i = 1; i < 5_000; i += 2) {
      expect(world.is_alive(entities[i])).toBe(true);
      expect(world.get_field(entities[i], Data, "a")).toBe(i);
      expect(world.get_field(entities[i], Data, "b")).toBe(i + 1);
      expect(world.get_field(entities[i], Data, "c")).toBe(i + 2);
    }
  });

  it("column growth: push 10,000 entities, verify no corruption", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const entities = [];
    for (let i = 0; i < 10_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: -i });
      entities.push(e);
    }

    // Verify all data
    for (let i = 0; i < 10_000; i++) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(-i);
    }
  });

  it("swap-and-pop: 1,000 entities, destroy from front 500×, verify remaining data", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const entities = [];
    for (let i = 0; i < 1_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 10 });
      entities.push(e);
    }

    // Destroy first 500
    for (let i = 0; i < 500; i++) {
      world.destroy_entity_deferred(entities[i]);
    }
    world.flush();

    // Remaining 500 should have correct data
    for (let i = 500; i < 1_000; i++) {
      expect(world.is_alive(entities[i])).toBe(true);
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 10);
    }
  });

  it("batch ops at scale: batch_add to archetype with 1,000 entities", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(["vx", "vy"] as const);

    // Create 1,000 entities with just Position
    const entities = [];
    for (let i = 0; i < 1_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 2 });
      entities.push(e);
    }

    // Get the archetype containing [Pos] only (not Vel)
    const pos_only_query = world.query(Pos).not(Vel);
    const pos_archs = [...pos_only_query];
    expect(pos_archs.length).toBe(1);
    const src_arch = pos_archs[0];
    expect(src_arch.entity_count).toBe(1_000);

    // Batch add Velocity to all entities in that archetype
    world.batch_add_component(src_arch, Vel, { vx: 1, vy: 2 });

    // Verify all entities now have both components with correct data
    for (const e of entities) {
      expect(world.has_component(e, Pos)).toBe(true);
      expect(world.has_component(e, Vel)).toBe(true);
      expect(world.get_field(e, Vel, "vx")).toBe(1);
      expect(world.get_field(e, Vel, "vy")).toBe(2);
    }

    // Verify original Position data is preserved
    for (let i = 0; i < entities.length; i++) {
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 2);
    }
  });
});
