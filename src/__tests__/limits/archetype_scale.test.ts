import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import type { EntityID } from "../../entity";

describe("Archetype scale", () => {
  it("32 components, entities with unique subsets create distinct archetypes", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 32; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    // Create entities with component combos: {0}, {0,1}, {0,1,2}, ...
    world.query(comps[0]); // register query before entities exist
    for (let i = 0; i < 32; i++) {
      const e = world.create_entity();
      for (let j = 0; j <= i; j++) {
        world.add_component(e, comps[j], { v: j });
      }
    }

    // Each entity created a unique archetype containing comp[0]
    expect(world.query(comps[0]).archetype_count).toBeGreaterThanOrEqual(32);
  });

  it("add 1 component at a time through 20 transitions, data preserved at every step", () => {
    const world = new ECS();
    const comps = [];
    for (let i = 0; i < 20; i++) {
      comps.push(world.register_component(["v"] as const));
    }

    const e = world.create_entity();
    for (let i = 0; i < 20; i++) {
      world.add_component(e, comps[i], { v: i * 10 });

      // Verify all previously added components still have correct data
      for (let j = 0; j <= i; j++) {
        expect(world.get_field(e, comps[j], "v")).toBe(j * 10);
      }
    }
  });

  it("1,000 entities across ~50 archetypes, query over common component finds all", () => {
    const world = new ECS();
    const Common = world.register_component(["v"] as const);
    const extras = [];
    for (let i = 0; i < 50; i++) {
      extras.push(world.register_tag());
    }

    const all_entities = [];
    for (let i = 0; i < 1_000; i++) {
      const e = world.create_entity();
      world.add_component(e, Common, { v: i });
      // Add a tag based on i % 50 to spread across archetypes
      world.add_component(e, extras[i % 50]);
      all_entities.push(e);
    }

    const q = world.query(Common);
    let total = 0;
    for (const arch of q) {
      total += arch.entity_count;
    }
    expect(total).toBe(1_000);
  });

  it("edge cache: 500 entities with same component sequence, archetype_count stays constant", () => {
    const world = new ECS();
    const A = world.register_component(["v"] as const);
    const B = world.register_component(["v"] as const);

    // First entity establishes the archetypes
    const e0 = world.create_entity();
    world.add_component(e0, A, { v: 0 });
    world.add_component(e0, B, { v: 0 });
    const count_after_first = world.query(A).archetype_count;

    // 499 more entities with same sequence
    for (let i = 1; i < 500; i++) {
      const e = world.create_entity();
      world.add_component(e, A, { v: i });
      world.add_component(e, B, { v: i });
    }

    expect(world.query(A).archetype_count).toBe(count_after_first);
  });

  it("tag-only scaling: 1,000 entities with various tag combos, correctness verified", () => {
    const world = new ECS();
    const tags = [];
    for (let i = 0; i < 10; i++) {
      tags.push(world.register_tag());
    }

    const entities = [];
    for (let i = 0; i < 1_000; i++) {
      const e = world.create_entity();
      // Add tags based on bit pattern of i % 1024
      for (let t = 0; t < 10; t++) {
        if ((i >> t) & 1) {
          world.add_component(e, tags[t]);
        }
      }
      entities.push(e);
    }

    // Verify tag 0 query finds all entities with bit 0 set
    const q0 = world.query(tags[0]);
    let found_count = 0;
    const found_set = new Set<EntityID>();
    for (const arch of q0) {
      found_count += arch.entity_count;
      for (const eid of arch.entity_list) {
        found_set.add(eid as EntityID);
      }
    }

    // Count how many entities should have tag 0 (odd indices)
    let expected = 0;
    for (let i = 0; i < 1_000; i++) {
      if (i & 1) expected++;
    }
    expect(found_count).toBe(expected);

    for (let i = 0; i < 1_000; i++) {
      if (i & 1) {
        expect(found_set.has(entities[i])).toBe(true);
      }
    }
  });
});
