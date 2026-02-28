import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

const Position = ["x", "y"] as const;

describe("Entity scale", () => {
  it("creates 10,000 entities, all alive and entity_count correct", () => {
    const world = new ECS();
    const entities = [];
    for (let i = 0; i < 10_000; i++) {
      entities.push(world.create_entity());
    }
    expect(world.entity_count).toBe(10_000);
    for (const e of entities) {
      expect(world.is_alive(e)).toBe(true);
    }
  });

  it("creates 10,000 then destroys 5,000 — survivors alive, dead are dead", () => {
    const world = new ECS();
    const entities = [];
    for (let i = 0; i < 10_000; i++) {
      entities.push(world.create_entity());
    }

    for (let i = 0; i < 5_000; i++) {
      world.destroy_entity_deferred(entities[i]);
    }
    world.flush();

    expect(world.entity_count).toBe(5_000);
    for (let i = 0; i < 5_000; i++) {
      expect(world.is_alive(entities[i])).toBe(false);
    }
    for (let i = 5_000; i < 10_000; i++) {
      expect(world.is_alive(entities[i])).toBe(true);
    }
  });

  it("creates 10,000 with Position, destroy odd-indexed, verify even-indexed data intact", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const entities = [];
    for (let i = 0; i < 10_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Pos, { x: i, y: i * 2 });
      entities.push(e);
    }

    // Destroy odd-indexed
    for (let i = 1; i < 10_000; i += 2) {
      world.destroy_entity_deferred(entities[i]);
    }
    world.flush();

    // Verify even-indexed still have correct data
    for (let i = 0; i < 10_000; i += 2) {
      expect(world.is_alive(entities[i])).toBe(true);
      expect(world.get_field(entities[i], Pos, "x")).toBe(i);
      expect(world.get_field(entities[i], Pos, "y")).toBe(i * 2);
    }
  });

  it("entity ID recycling: create 1,000 → destroy all → create 1,000 more, old IDs dead", () => {
    const world = new ECS();
    const old_entities = [];
    for (let i = 0; i < 1_000; i++) {
      old_entities.push(world.create_entity());
    }
    for (const e of old_entities) {
      world.destroy_entity_deferred(e);
    }
    world.flush();

    const new_entities = [];
    for (let i = 0; i < 1_000; i++) {
      new_entities.push(world.create_entity());
    }

    for (const e of old_entities) {
      expect(world.is_alive(e)).toBe(false);
    }
    for (const e of new_entities) {
      expect(world.is_alive(e)).toBe(true);
    }
    expect(world.entity_count).toBe(1_000);
  });

  it("interleaved create/destroy (create 100, destroy 50, repeat 20×), final state correct", () => {
    const world = new ECS();
    const alive: Set<EntityID> = new Set();
    let all_entities: EntityID[] = [];

    for (let round = 0; round < 20; round++) {
      const batch = [];
      for (let i = 0; i < 100; i++) {
        const e = world.create_entity();
        batch.push(e);
        alive.add(e);
      }
      all_entities = all_entities.concat(batch);

      // Destroy 50 from the alive set
      const alive_arr = [...alive];
      for (let i = 0; i < 50 && i < alive_arr.length; i++) {
        world.destroy_entity_deferred(alive_arr[i]);
        alive.delete(alive_arr[i]);
      }
      world.flush();
    }

    expect(world.entity_count).toBe(alive.size);
    for (const e of alive) {
      expect(world.is_alive(e)).toBe(true);
    }
  });
});
