import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";

// Field arrays
const Position = ["x", "y"] as const;
const Velocity = ["vx", "vy"] as const;
const Health = ["hp"] as const;
const Static = [] as const; // tag component

describe("ECS query", () => {
  //=========================================================
  // Basic query
  //=========================================================

  it("query returns matching archetypes", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });

    // Query [Pos, Vel] should match only e1's archetype
    const matches = world.query(Pos, Vel);
    expect(matches.archetype_count).toBe(1);
    expect(matches.archetypes[0].entity_list).toContain(e1);
  });

  it("query with single component returns all archetypes containing it", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });
    world.add_component(e1, Vel, { vx: 0, vy: 0 });

    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 0, y: 0 });

    // Query [Pos] should match both archetypes
    const matches = world.query(Pos);
    const all_entities = [...matches].flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);
  });

  //=========================================================
  // Cache behavior
  //=========================================================

  it("cached query returns same reference on repeated calls", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const first = world.query(Pos);
    const second = world.query(Pos);

    // Same reference - live Query
    expect(first).toBe(second);
  });

  it("cache is stable when no new archetypes are created", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });

    const first = world.query(Pos);

    // Adding another entity to the same archetype does NOT create a new archetype
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 1, y: 1 });

    const second = world.query(Pos);

    // Same reference, same length
    expect(second).toBe(first);
    expect(second.archetype_count).toBe(first.archetype_count);
  });

  it("unrelated archetype does not grow the query result", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Hp = world.register_component(Health);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });

    const result = world.query(Pos);
    const length_before = result.archetype_count;

    // Create an entity with only Health — unrelated to Pos query
    const e2 = world.create_entity();
    world.add_component(e2, Hp, { hp: 100 });

    const after = world.query(Pos);

    // Same reference, same archetype_count
    expect(after).toBe(result);
    expect(after.archetype_count).toBe(length_before);
  });

  //=========================================================
  // Component order independence
  //=========================================================

  it("query result is the same regardless of component order", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 0, y: 0 });
    world.add_component(e1, Vel, { vx: 0, vy: 0 });

    const result_a = world.query(Pos, Vel);
    const result_b = world.query(Vel, Pos);

    expect(result_a).toBe(result_b);
  });

  //=========================================================
  // Query.not() — exclusion filtering
  //=========================================================

  it("not() excludes archetypes that have the given component", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Stat = world.register_component(Static);

    // e1: Pos + Vel (not static)
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Vel + Static (excluded)
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Vel, { vx: 7, vy: 8 });
    world.add_component(e2, Stat, {});

    const q = world.query(Pos, Vel).not(Stat);

    // Only e1's archetype should match
    expect(q.archetype_count).toBe(1);

    // e2 should not appear in any archetype
    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).not.toContain(e2);
  });

  it("not() cache hit — same Query reference returned on repeated calls", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Stat = world.register_component(Static);

    const q1 = world.query(Pos, Vel).not(Stat);
    const q2 = world.query(Pos, Vel).not(Stat);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.and() — extend required set
  //=========================================================

  it("and() returns same cached Query as query() with both components", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q_chained = world.query(Pos).and(Vel);
    const q_direct = world.query(Pos, Vel);

    expect(q_chained).toBe(q_direct);
  });

  it("and() chaining is order-independent — same mask → same result", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const q1 = world.query(Pos).and(Vel);
    const q2 = world.query(Vel).and(Pos);

    expect(q1).toBe(q2);
  });

  it("and() cache hit — same Query reference on repeated chains", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);

    const q1 = world.query(Pos).and(Vel);
    const q2 = world.query(Pos).and(Vel);

    expect(q1).toBe(q2);
  });

  it("and() skips duplicate components already in include mask", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);

    const q1 = world.query(Pos).and(Pos);
    const q2 = world.query(Pos);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.any_of() — any-of filtering
  //=========================================================

  it("any_of() passes archetypes with at least one of the any_of-components", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    // e1: Pos + Vel
    const e1 = world.create_entity();
    world.add_component(e1, Pos, { x: 1, y: 2 });
    world.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Hp
    const e2 = world.create_entity();
    world.add_component(e2, Pos, { x: 5, y: 6 });
    world.add_component(e2, Hp, { hp: 100 });

    // e3: Pos only — no Vel or Hp
    const e3 = world.create_entity();
    world.add_component(e3, Pos, { x: 7, y: 8 });

    const q = world.query(Pos).any_of(Vel, Hp);

    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).toContain(e2);
    expect(entity_ids).not.toContain(e3);
  });

  it("any_of() cache hit — same Query reference on repeated calls", () => {
    const world = new ECS();
    const Pos = world.register_component(Position);
    const Vel = world.register_component(Velocity);
    const Hp = world.register_component(Health);

    const q1 = world.query(Pos).any_of(Vel, Hp);
    const q2 = world.query(Pos).any_of(Vel, Hp);

    expect(q1).toBe(q2);
  });
});
