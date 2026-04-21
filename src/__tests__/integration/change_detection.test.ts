import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";

describe("Change Detection", () => {
  //=========================================================
  // Tick basics
  //=========================================================

  it("get_column_mut sets _changed_tick on archetype", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    const q = world.query(Pos);
    q.for_each((arch) => {
      expect(arch._changed_tick[Pos as unknown as number]).toBe(0);
      arch.get_column_mut(Pos, "x", 5);
      expect(arch._changed_tick[Pos as unknown as number]).toBe(5);
    });
  });

  it("get_column does NOT set _changed_tick", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    const q = world.query(Pos);
    q.for_each((arch) => {
      arch.get_column(Pos, "x");
      expect(arch._changed_tick[Pos as unknown as number]).toBe(0);
    });
  });

  //=========================================================
  // ref_mut ticks eagerly
  //=========================================================

  it("ref_mut ticks component as changed at creation time", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    let ticked = false;
    const sys = world.register_system((ctx) => {
      ctx.ref_mut(Pos, e);
      // Check the archetype directly
      const q = world.query(Pos);
      q.for_each((arch) => {
        expect(arch._changed_tick[Pos as unknown as number]).toBe(ctx.world_tick);
        ticked = true;
      });
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(1 / 60);
    expect(ticked).toBe(true);
  });

  //=========================================================
  // ChangedQuery filtering
  //=========================================================

  it("changed() includes archetypes modified this tick", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Vel = world.register_component(["vx", "vy"] as const);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });
    world.add_component(e, Vel, { vx: 1, vy: 1 });

    let change_count = 0;
    const writer = world.register_system(
      (q, ctx) => {
        q.for_each((arch) => {
          arch.get_column_mut(Pos, "x", ctx.world_tick);
        });
      },
      (qb) => qb.every(Pos, Vel),
    );

    const detector = world.register_system(
      (q) => {
        q.changed(Pos).for_each(() => {
          change_count++;
        });
      },
      (qb) => qb.every(Pos, Vel),
    );

    world.add_systems(SCHEDULE.UPDATE, writer, { system: detector, ordering: { after: [writer] } });
    world.startup();

    world.update(1 / 60);
    expect(change_count).toBe(1);

    world.update(1 / 60);
    expect(change_count).toBe(2);
  });

  //=========================================================
  // Structural transitions tick destination
  //=========================================================

  it("structural transition ticks all components on destination archetype", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);
    const Tag = world.register_tag();

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 1, y: 2 });

    // Two updates: store._tick is set to _tick at the start of each update(),
    // then _tick increments at the end. After two updates store._tick = 1.
    world.update(1 / 60);
    world.update(1 / 60);

    // add_component triggers an archetype transition using store._tick (= 1)
    world.add_component(e, Tag);

    const q = world.query(Pos, Tag);
    q.for_each((arch) => {
      // move_entity_from marks all dst components as changed at the current store tick
      expect(arch._changed_tick[Pos as unknown as number]).toBe(1);
    });
  });

  //=========================================================
  // add_entity does NOT tick
  //=========================================================

  it("add_entity zero-fill does not independently tick", () => {
    const world = new ECS();
    const Pos = world.register_component(["x", "y"] as const);

    // Two updates to advance store._tick to 1
    world.update(1 / 60);
    world.update(1 / 60);

    const e = world.create_entity();
    world.add_component(e, Pos, { x: 0, y: 0 });

    const q = world.query(Pos);
    q.for_each((arch) => {
      // Ticked from write_fields in add_component at store._tick (= 1),
      // not from add_entity which only pushes zeroes without ticking
      expect(arch._changed_tick[Pos as unknown as number]).toBe(1);
    });
  });
});
