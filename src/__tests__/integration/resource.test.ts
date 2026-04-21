import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { resource_key } from "../../resource";
import { ECS_ERROR, ECSError } from "../../utils/error";

describe("Resource system", () => {
  // ==== Resource key system ====

  it("insert and read a resource by key", () => {
    const world = new ECS();
    const TimeRes = resource_key<{ delta: number; elapsed: number }>("Time");
    world.register_resource(TimeRes, { delta: 0.016, elapsed: 1.5 });
    const time = world.resource(TimeRes);
    expect(time.delta).toBe(0.016);
    expect(time.elapsed).toBe(1.5);
  });

  it("resource returns mutable reference — direct mutation works", () => {
    const world = new ECS();
    const Counter = resource_key<{ value: number }>("Counter");
    world.register_resource(Counter, { value: 0 });
    const counter = world.resource(Counter);
    counter.value = 42;
    expect(world.resource(Counter).value).toBe(42);
  });

  it("set_resource replaces the value entirely", () => {
    const world = new ECS();
    const Config = resource_key<{ speed: number }>("Config");
    world.register_resource(Config, { speed: 10 });
    world.set_resource(Config, { speed: 99 });
    expect(world.resource(Config).speed).toBe(99);
  });

  it("has_resource returns false before insert, true after", () => {
    const world = new ECS();
    const Res = resource_key<{ x: number }>("Res");
    expect(world.has_resource(Res)).toBe(false);
    world.register_resource(Res, { x: 1 });
    expect(world.has_resource(Res)).toBe(true);
  });

  it("duplicate insert throws RESOURCE_ALREADY_REGISTERED", () => {
    const world = new ECS();
    const Res = resource_key<{ x: number }>("Res");
    world.register_resource(Res, { x: 1 });
    try {
      world.register_resource(Res, { x: 2 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_ALREADY_REGISTERED);
    }
  });

  it("resource() on missing key throws RESOURCE_NOT_REGISTERED", () => {
    const world = new ECS();
    const Res = resource_key<{ x: number }>("Missing");
    try {
      world.resource(Res);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
    }
  });

  it("set_resource on missing key throws RESOURCE_NOT_REGISTERED", () => {
    const world = new ECS();
    const Res = resource_key<{ x: number }>("Missing");
    try {
      world.set_resource(Res, { x: 1 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.RESOURCE_NOT_REGISTERED);
    }
  });

  it("multiple key resources are independent", () => {
    const world = new ECS();
    const A = resource_key<{ val: number }>("A");
    const B = resource_key<{ val: number }>("B");
    world.register_resource(A, { val: 10 });
    world.register_resource(B, { val: 20 });
    world.resource(A).val = 99;
    expect(world.resource(B).val).toBe(20);
  });

  it("stores non-numeric values (objects, class instances)", () => {
    const world = new ECS();
    class Renderer {
      public count = 0;
      update() {
        this.count++;
      }
    }
    const RendererRes = resource_key<Renderer>("Renderer");
    const instance = new Renderer();
    world.register_resource(RendererRes, instance);
    const r = world.resource(RendererRes);
    r.update();
    r.update();
    expect(r.count).toBe(2);
    expect(r).toBe(instance);
  });

  it("ctx.resource reads key-based resources within systems", () => {
    const world = new ECS();
    const Config = resource_key<{ speed: number }>("Config");
    world.register_resource(Config, { speed: 42 });
    let read_speed = -1;
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        read_speed = ctx.resource(Config).speed;
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);
    expect(read_speed).toBe(42);
  });

  it("ctx.set_resource replaces key-based resources within systems", () => {
    const world = new ECS();
    const State = resource_key<{ phase: number }>("State");
    world.register_resource(State, { phase: 0 });
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        ctx.set_resource(State, { phase: 3 });
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);
    expect(world.resource(State).phase).toBe(3);
  });

  it("direct mutation within system persists across frames", () => {
    const world = new ECS();
    const Counter = resource_key<{ value: number }>("Counter");
    world.register_resource(Counter, { value: 0 });
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        ctx.resource(Counter).value++;
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);
    world.update(0);
    world.update(0);
    expect(world.resource(Counter).value).toBe(3);
  });

  it("ctx.has_resource returns correct values within systems", () => {
    const world = new ECS();
    const Inserted = resource_key<{ x: number }>("Inserted");
    const NotInserted = resource_key<{ x: number }>("NotInserted");
    world.register_resource(Inserted, { x: 1 });
    let has_inserted = false;
    let has_not_inserted = true;
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        has_inserted = ctx.has_resource(Inserted);
        has_not_inserted = ctx.has_resource(NotInserted);
      },
    });
    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();
    world.update(0);
    expect(has_inserted).toBe(true);
    expect(has_not_inserted).toBe(false);
  });
});
