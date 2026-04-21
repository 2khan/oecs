import { describe, expect, it } from "vitest";
import { ECS } from "../../ecs";
import { SCHEDULE } from "../../schedule";
import type { SystemContext } from "../../query";
import { event_key, signal_key } from "../../event";
import { ECS_ERROR, ECSError } from "../../utils/error";

describe("Event system", () => {
  // ==== Event key registration and emit/read ====

  it("emit in one system, read in a later system within the same update", () => {
    const world = new ECS();
    const Damage = event_key<readonly ["target", "amount"]>("Damage");
    world.register_event(Damage, ["target", "amount"] as const);
    const received: { target: number; amount: number }[] = [];

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Damage, { target: 42, amount: 10 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const dmg = ctx.read(Damage);
        for (let i = 0; i < dmg.length; i++) {
          received.push({ target: dmg.target[i], amount: dmg.amount[i] });
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(received).toEqual([{ target: 42, amount: 10 }]);
  });

  it("events are cleared between frames", () => {
    const world = new ECS();
    const Hit = event_key<readonly ["damage"]>("Hit");
    world.register_event(Hit, ["damage"] as const);

    let read_length = -1;
    let frame = 0;
    const sys = world.register_system({
      fn(ctx: SystemContext) {
        if (frame === 0) {
          ctx.emit(Hit, { damage: 99 });
        }
        read_length = ctx.read(Hit).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, sys);
    world.startup();

    frame = 0;
    world.update(0);
    expect(read_length).toBe(1);

    frame = 1;
    world.update(0);
    expect(read_length).toBe(0);
  });

  it("signal (zero-field) events work", () => {
    const world = new ECS();
    const GameOver = signal_key("GameOver");
    world.register_signal(GameOver);
    let fired = false;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(GameOver);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        if (ctx.read(GameOver).length > 0) {
          fired = true;
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(fired).toBe(true);
  });

  it("multiple emits accumulate within a frame", () => {
    const world = new ECS();
    const Score = event_key<readonly ["points"]>("Score");
    world.register_event(Score, ["points"] as const);
    const totals: number[] = [];

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Score, { points: 10 });
        ctx.emit(Score, { points: 20 });
        ctx.emit(Score, { points: 30 });
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        const s = ctx.read(Score);
        for (let i = 0; i < s.length; i++) {
          totals.push(s.points[i]);
        }
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(totals).toEqual([10, 20, 30]);
  });

  it("startup events are readable in POST_STARTUP", () => {
    const world = new ECS();
    const Ready = signal_key("Ready");
    world.register_signal(Ready);
    let read_count = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Ready);
        ctx.emit(Ready);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        read_count = ctx.read(Ready).length;
      },
    });

    world.add_systems(SCHEDULE.STARTUP, emitter);
    world.add_systems(SCHEDULE.POST_STARTUP, reader);
    world.startup();

    expect(read_count).toBe(2);
  });

  it("reading an event with no emits returns length 0", () => {
    const world = new ECS();
    const Nothing = event_key<readonly ["value"]>("Nothing");
    world.register_event(Nothing, ["value"] as const);
    let read_length = -1;

    const reader = world.register_system({
      fn(ctx: SystemContext) {
        read_length = ctx.read(Nothing).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, reader);
    world.startup();
    world.update(0);

    expect(read_length).toBe(0);
  });

  it("multiple signal emits accumulate", () => {
    const world = new ECS();
    const Tick = signal_key("Tick");
    world.register_signal(Tick);
    let count = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Tick);
        ctx.emit(Tick);
        ctx.emit(Tick);
      },
    });
    const reader = world.register_system({
      fn(ctx: SystemContext) {
        count = ctx.read(Tick).length;
      },
    });

    world.add_systems(SCHEDULE.UPDATE, emitter, {
      system: reader,
      ordering: { after: [emitter] },
    });
    world.startup();
    world.update(0);

    expect(count).toBe(3);
  });

  it("events emitted in PRE_UPDATE are readable in UPDATE and POST_UPDATE", () => {
    const world = new ECS();
    const Input = event_key<readonly ["key"]>("Input");
    world.register_event(Input, ["key"] as const);
    let update_len = 0;
    let post_update_len = 0;

    const emitter = world.register_system({
      fn(ctx: SystemContext) {
        ctx.emit(Input, { key: 65 });
      },
    });
    const update_reader = world.register_system({
      fn(ctx: SystemContext) {
        update_len = ctx.read(Input).length;
      },
    });
    const post_update_reader = world.register_system({
      fn(ctx: SystemContext) {
        post_update_len = ctx.read(Input).length;
      },
    });

    world.add_systems(SCHEDULE.PRE_UPDATE, emitter);
    world.add_systems(SCHEDULE.UPDATE, update_reader);
    world.add_systems(SCHEDULE.POST_UPDATE, post_update_reader);
    world.startup();
    world.update(0);

    expect(update_len).toBe(1);
    expect(post_update_len).toBe(1);
  });

  // ==== Error handling ====

  it("duplicate register_event throws EVENT_ALREADY_REGISTERED", () => {
    const world = new ECS();
    const Ev = event_key<readonly ["x"]>("Ev");
    world.register_event(Ev, ["x"] as const);

    try {
      world.register_event(Ev, ["x"] as const);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_ALREADY_REGISTERED);
    }
  });

  it("emit on unregistered key throws EVENT_NOT_REGISTERED", () => {
    const world = new ECS();
    const Ev = event_key<readonly ["x"]>("Unregistered");

    try {
      world.emit(Ev, { x: 1 });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_NOT_REGISTERED);
    }
  });

  it("read on unregistered key throws EVENT_NOT_REGISTERED", () => {
    const world = new ECS();
    const Ev = event_key<readonly ["x"]>("Unregistered");

    try {
      world.read(Ev);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ECSError);
      expect((e as ECSError).category).toBe(ECS_ERROR.EVENT_NOT_REGISTERED);
    }
  });

  // ==== ECS.read and ECS.emit (facade-level) ====

  it("ECS.read works for reading events outside systems", () => {
    const world = new ECS();
    const Score = event_key<readonly ["points"]>("Score");
    world.register_event(Score, ["points"] as const);

    world.emit(Score, { points: 42 });
    const reader = world.read(Score);
    expect(reader.length).toBe(1);
    expect(reader.points[0]).toBe(42);
  });

  it("ECS.emit signal works at facade level", () => {
    const world = new ECS();
    const Ping = signal_key("Ping");
    world.register_signal(Ping);

    world.emit(Ping);
    expect(world.read(Ping).length).toBe(1);
  });
});
