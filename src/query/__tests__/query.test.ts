import { describe, expect, it } from "vitest";
import { SystemContext } from "../query";
import { Store } from "../../store/store";

// Schemas
const Position = { x: "f32", y: "f32" } as const;
const Velocity = { vx: "f32", vy: "f32" } as const;
const Health = { hp: "f32" } as const;
const Static = {} as const; // tag component

describe("SystemContext", () => {
  //=========================================================
  // Basic query
  //=========================================================

  it("query returns matching archetypes", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });

    // Query [Pos, Vel] should match only e1's archetype
    const matches = ctx.query(Pos, Vel);
    expect(matches.length).toBe(1);
    expect(matches.archetypes[0].entity_list).toContain(e1);
  });

  it("query with single component returns all archetypes containing it", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0 });

    // Query [Pos] should match both archetypes
    const matches = ctx.query(Pos);
    const all_entities = [...matches].flatMap((a) => [...a.entity_list]);
    expect(all_entities).toContain(e1);
    expect(all_entities).toContain(e2);
  });

  //=========================================================
  // Cache behavior
  //=========================================================

  it("cached query returns same reference on repeated calls", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const first = ctx.query(Pos);
    const second = ctx.query(Pos);

    // Same reference - live Query
    expect(first).toBe(second);
  });

  it("live query result grows when new matching archetype is created", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const result = ctx.query(Pos);
    const length_before = result.length;
    expect(length_before).toBeGreaterThan(0);

    // Adding a new component combo creates a new archetype containing Pos
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 0, y: 0 });
    store.add_component(e2, Vel, { vx: 0, vy: 0 });

    // Same reference — live array was updated in-place by the registry
    const after = ctx.query(Pos);
    expect(after).toBe(result);
    expect(after.length).toBeGreaterThan(length_before);
  });

  it("cache is stable when no new archetypes are created", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });

    const first = ctx.query(Pos);

    // Adding another entity to the same archetype does NOT create a new archetype
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 1, y: 1 });

    const second = ctx.query(Pos);

    // Same reference, same length
    expect(second).toBe(first);
    expect(second.length).toBe(first.length);
  });

  it("unrelated archetype does not grow the query result", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Hp = store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    const result = ctx.query(Pos);
    const length_before = result.length;

    // Create an entity with only Health — unrelated to Pos query
    const e2 = store.create_entity();
    store.add_component(e2, Hp, { hp: 100 });

    const after = ctx.query(Pos);

    // Same reference, same length
    expect(after).toBe(result);
    expect(after.length).toBe(length_before);
  });

  //=========================================================
  // Component order independence
  //=========================================================

  it("query result is the same regardless of component order", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 0, y: 0 });
    store.add_component(e1, Vel, { vx: 0, vy: 0 });

    const result_a = ctx.query(Pos, Vel);
    const result_b = ctx.query(Vel, Pos);

    expect(result_a).toBe(result_b);
  });

  //=========================================================
  // Deferred destruction via SystemContext
  //=========================================================

  it("destroy_entity defers — entity stays alive after call", () => {
    const store = new Store();
    const ctx = new SystemContext(store);

    const id = store.create_entity();
    ctx.destroy_entity(id);

    expect(store.is_alive(id)).toBe(true);
  });

  it("flush_destroyed processes the deferred buffer", () => {
    const store = new Store();
    const ctx = new SystemContext(store);

    const id = store.create_entity();
    ctx.destroy_entity(id);
    ctx.flush_destroyed();

    expect(store.is_alive(id)).toBe(false);
  });

  //=========================================================
  // Column access integration
  //=========================================================

  it("allows column access through archetype dense columns", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 10, y: 20 });
    store.add_component(e1, Vel, { vx: 1, vy: 2 });

    for (const arch of ctx.query(Pos, Vel)) {
      const px = arch.get_column(Pos, "x");
      const vy = arch.get_column(Vel, "vy");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(px[i]).toBe(10);
        expect(vy[i]).toBe(2);
      }
    }
  });

  //=========================================================
  // Deferred structural changes + query consistency
  //=========================================================

  it("deferred add_component does not change query result length until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // Cache a query for [Pos, Vel] — currently empty
    const before = ctx.query(Pos, Vel);
    expect(before.length).toBe(0);

    // Deferred add — should NOT change cached query
    ctx.add_component(e1, Vel, { vx: 3, vy: 4 });
    const still_before = ctx.query(Pos, Vel);
    expect(still_before.length).toBe(0);

    // After flush, the live array has grown
    ctx.flush();
    const after = ctx.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after.archetypes[0].entity_list).toContain(e1);
  });

  it("deferred remove_component does not change query result until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    // Cache a query for [Pos, Vel] — entity e1 is in it
    const before = ctx.query(Pos, Vel);
    expect(before.length).toBe(1);
    expect(before.archetypes[0].entity_count).toBe(1);

    // Deferred remove — entity still appears in its archetype
    ctx.remove_component(e1, Vel);
    expect(before.archetypes[0].entity_count).toBe(1);

    // After flush, entity has moved out
    ctx.flush();
    expect(before.archetypes[0].entity_count).toBe(0);
  });

  it("two systems in sequence see consistent state until flush", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // "System 1" queries and defers a structural change
    const system1_result = ctx.query(Pos);
    expect([...system1_result].flatMap((a) => [...a.entity_list])).toContain(e1);
    ctx.add_component(e1, Vel, { vx: 0, vy: 0 });

    // "System 2" queries — still sees old archetypes only
    const system2_result_pos_vel = ctx.query(Pos, Vel);
    expect(system2_result_pos_vel.length).toBe(0);

    // Flush between phases
    ctx.flush();

    // Now re-query sees updated state (live array grew)
    const after = ctx.query(Pos, Vel);
    expect(after.length).toBe(1);
    expect(after.archetypes[0].entity_list).toContain(e1);
  });

  it("flush processes structural changes before destructions", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });

    // Defer add then destroy
    ctx.add_component(e1, Vel, { vx: 0, vy: 0 });
    ctx.destroy_entity(e1);

    // After flush: structural applies (add Vel), then destroy runs
    ctx.flush();
    expect(store.is_alive(e1)).toBe(false);
  });

  //=========================================================
  // Query.each() — typed column iteration
  //=========================================================

  it("each() calls fn once per non-empty archetype with correct columns and count", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 10, y: 20 });
    store.add_component(e1, Vel, { vx: 1, vy: 2 });

    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 30, y: 40 });
    store.add_component(e2, Vel, { vx: 3, vy: 4 });

    let call_count = 0;
    let total_entities = 0;

    ctx.query(Pos, Vel).each((pos, vel, n) => {
      call_count++;
      total_entities += n;
      // Verify typed columns are accessible
      for (let i = 0; i < n; i++) {
        expect(typeof pos.x[i]).toBe("number");
        expect(typeof vel.vx[i]).toBe("number");
      }
    });

    expect(call_count).toBe(1); // one archetype
    expect(total_entities).toBe(2);
  });

  it("each() skips archetypes with zero entities", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 0, vy: 0 });

    const q = ctx.query(Pos, Vel);

    // Remove entity so archetype becomes empty
    store.destroy_entity(e1);

    let call_count = 0;
    q.each((_pos, _vel, _n) => { call_count++; });
    expect(call_count).toBe(0);
  });

  it("each() reflects correct typed array values", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 5, y: 7 });
    store.add_component(e1, Vel, { vx: 2, vy: 3 });

    ctx.query(Pos, Vel).each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i]; // 5 + 2 = 7
        pos.y[i] += vel.vy[i]; // 7 + 3 = 10
      }
    });

    // Verify mutation via get_column
    for (const arch of ctx.query(Pos, Vel)) {
      const x = arch.get_column(Pos, "x");
      const y = arch.get_column(Pos, "y");
      for (let i = 0; i < arch.entity_count; i++) {
        expect(x[i]).toBe(7);
        expect(y[i]).toBe(10);
      }
    }
  });

  //=========================================================
  // Query.not() — exclusion filtering
  //=========================================================

  it("not() excludes archetypes that have the given component", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Stat = store.register_component(Static);
    const ctx = new SystemContext(store);

    // e1: Pos + Vel (not static)
    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Vel + Static (excluded)
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });
    store.add_component(e2, Vel, { vx: 7, vy: 8 });
    store.add_component(e2, Stat, {});

    const q = ctx.query(Pos, Vel).not(Stat);

    // Only e1's archetype should match
    const all_entities: number[] = [];
    q.each((_pos, _vel, n) => { all_entities.push(n); });

    expect(q.length).toBe(1);

    // e2 should not appear in any archetype
    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).not.toContain(e2);
  });

  it("not() live — newly created excluded archetype does not appear", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Stat = store.register_component(Static);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = ctx.query(Pos, Vel).not(Stat);
    const before_len = q.length;

    // Create a new entity with the excluded component
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });
    store.add_component(e2, Vel, { vx: 7, vy: 8 });
    store.add_component(e2, Stat, {});

    // Live array should NOT have grown — excluded archetype rejected
    expect(q.length).toBe(before_len);
  });

  it("not() cache hit — same Query reference returned on repeated calls", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Stat = store.register_component(Static);
    const ctx = new SystemContext(store);

    const q1 = ctx.query(Pos, Vel).not(Stat);
    const q2 = ctx.query(Pos, Vel).not(Stat);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.and() — extend required set
  //=========================================================

  it("and() returns same cached Query as query() with both components", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q_chained = ctx.query(Pos).and(Vel);
    const q_direct  = ctx.query(Pos, Vel);

    expect(q_chained).toBe(q_direct);
  });

  it("and() chaining is order-independent — same mask → same result", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const q1 = ctx.query(Pos).and(Vel);
    const q2 = ctx.query(Vel).and(Pos);

    expect(q1).toBe(q2);
  });

  it("and() cache hit — same Query reference on repeated chains", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const ctx = new SystemContext(store);

    const q1 = ctx.query(Pos).and(Vel);
    const q2 = ctx.query(Pos).and(Vel);

    expect(q1).toBe(q2);
  });

  it("and() skips duplicate components already in include mask", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const ctx = new SystemContext(store);

    const q1 = ctx.query(Pos).and(Pos);
    const q2 = ctx.query(Pos);

    expect(q1).toBe(q2);
  });

  //=========================================================
  // Query.or() — any-of filtering
  //=========================================================

  it("or() passes archetypes with at least one of the or-components", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp  = store.register_component(Health);
    const ctx = new SystemContext(store);

    // e1: Pos + Vel
    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    // e2: Pos + Hp
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });
    store.add_component(e2, Hp, { hp: 100 });

    // e3: Pos only — no Vel or Hp
    const e3 = store.create_entity();
    store.add_component(e3, Pos, { x: 7, y: 8 });

    const q = ctx.query(Pos).or(Vel, Hp);

    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e1);
    expect(entity_ids).toContain(e2);
    expect(entity_ids).not.toContain(e3);
  });

  it("or() live — new matching archetype gets added to live array", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp  = store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = ctx.query(Pos).or(Vel, Hp);
    const before_len = q.length;

    // New archetype with Pos + Hp should be picked up
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });
    store.add_component(e2, Hp, { hp: 50 });

    expect(q.length).toBeGreaterThan(before_len);
    const entity_ids = [...q].flatMap((a) => [...a.entity_list]);
    expect(entity_ids).toContain(e2);
  });

  it("or() live — archetype with none of the or-components is not added", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp  = store.register_component(Health);
    const ctx = new SystemContext(store);

    const e1 = store.create_entity();
    store.add_component(e1, Pos, { x: 1, y: 2 });
    store.add_component(e1, Vel, { vx: 3, vy: 4 });

    const q = ctx.query(Pos).or(Vel);
    const before_len = q.length;

    // New archetype with Pos + Hp — Hp is NOT in the or-mask
    const e2 = store.create_entity();
    store.add_component(e2, Pos, { x: 5, y: 6 });
    store.add_component(e2, Hp, { hp: 50 });

    expect(q.length).toBe(before_len);
  });

  it("or() cache hit — same Query reference on repeated calls", () => {
    const store = new Store();
    const Pos = store.register_component(Position);
    const Vel = store.register_component(Velocity);
    const Hp  = store.register_component(Health);
    const ctx = new SystemContext(store);

    const q1 = ctx.query(Pos).or(Vel, Hp);
    const q2 = ctx.query(Pos).or(Vel, Hp);

    expect(q1).toBe(q2);
  });
});
