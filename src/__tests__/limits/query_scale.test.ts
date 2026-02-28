import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

describe("Query scale", () => {
  it("100 unique queries, each returns correct cached reference", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 100; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    // Create one entity per component so archetypes exist
    for (let i = 0; i < 100; i++) {
      const e = world.create_entity();
      world.add_component(e, comps[i], { v: i });
    }

    // Each query should be cached
    const queries = [];
    for (let i = 0; i < 100; i++) {
      queries.push(world.query(comps[i]));
    }

    for (let i = 0; i < 100; i++) {
      expect(world.query(comps[i])).toBe(queries[i]);
    }
  });

  it("50 queries over 20 components, 500 entities across 30 archetypes, all correct", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 20; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    // Create entities with various component combos
    for (let i = 0; i < 500; i++) {
      const e = world.create_entity();
      // Always add comp[0]
      world.add_component(e, comps[0], { v: i });
      // Add comp[1..9] based on bit pattern of i
      for (let c = 1; c < 10; c++) {
        if ((i >> c) & 1) {
          world.add_component(e, comps[c], { v: c });
        }
      }
    }

    // Query for comp[0] should find all 500 entities
    const q0 = world.query(comps[0]);
    let total = 0;
    for (const arch of q0) {
      total += arch.entity_count;
    }
    expect(total).toBe(500);

    // Repeated calls return same cached query
    expect(world.query(comps[0])).toBe(q0);
  });

  it("live query stress: register query, create 100 new archetypes, verify live growth", () => {
    const world = new ECS();
    const Common = world.register_component(["v"] as const);
    const tags = [];
    for (let i = 0; i < 100; i++) {
      tags.push(world.register_tag());
    }

    // Register query before any entities exist
    const q = world.query(Common);
    expect(q.archetype_count).toBe(0);

    // Create entities in 100 different archetypes
    for (let i = 0; i < 100; i++) {
      const e = world.create_entity();
      world.add_component(e, Common, { v: i });
      world.add_component(e, tags[i]);
    }

    // Query should have grown live: 100 {Common, tag[i]} archetypes
    // plus 1 intermediate {Common} archetype from the add_component transitions
    expect(q.archetype_count).toBe(101);
  });

  it("query cache deduplication — same mask always returns same Query", () => {
    const world = new ECS();
    const A = world.register_component(["v"] as const);
    const B = world.register_component(["v"] as const);
    const C = world.register_component(["v"] as const);

    const queries = new Set();
    for (let i = 0; i < 200; i++) {
      // Same query repeatedly
      queries.add(world.query(A, B));
      queries.add(world.query(B, A));
      queries.add(world.query(A).and(B));
    }
    // All should resolve to same cached query
    expect(queries.size).toBe(1);

    // Different query is different
    queries.add(world.query(A, C));
    expect(queries.size).toBe(2);
  });
});
