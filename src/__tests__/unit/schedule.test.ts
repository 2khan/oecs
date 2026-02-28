import { describe, expect, it } from "vitest";
import { Schedule, SCHEDULE } from "../../schedule";
import { SystemContext } from "../../query";
import { Store } from "../../store";
import {
  as_system_id,
  type SystemConfig,
  type SystemDescriptor,
  type SystemFn,
} from "../../system";

const noop: SystemFn = () => {};

function make_ctx(): SystemContext {
  return new SystemContext(new Store());
}

let _schedule_unit_next_id = 0;
function make_system(overrides?: Partial<SystemConfig>): SystemDescriptor {
  return Object.freeze({
    id: as_system_id(_schedule_unit_next_id++),
    fn: overrides?.fn ?? noop,
    on_added: overrides?.on_added,
    on_removed: overrides?.on_removed,
    dispose: overrides?.dispose,
  });
}

describe("Schedule", () => {
  //=========================================================
  // Basic add/has/remove
  //=========================================================

  it("add_systems and has_system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    expect(schedule.has_system(sys)).toBe(false);

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    expect(schedule.has_system(sys)).toBe(true);
  });

  it("remove_system removes from schedule", () => {
    const schedule = new Schedule();
    const sys = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    schedule.remove_system(sys);

    expect(schedule.has_system(sys)).toBe(false);
  });

  it("remove_system is a no-op for unscheduled system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    expect(() => schedule.remove_system(sys)).not.toThrow();
  });

  it("get_all_systems returns all scheduled systems", () => {
    const schedule = new Schedule();
    const a = make_system();
    const b = make_system();
    const c = make_system();

    schedule.add_systems(SCHEDULE.STARTUP, a);
    schedule.add_systems(SCHEDULE.UPDATE, b, c);

    const all = schedule.get_all_systems();
    expect(all).toContain(a);
    expect(all).toContain(b);
    expect(all).toContain(c);
    expect(all.length).toBe(3);
  });

  it("clear removes all systems", () => {
    const schedule = new Schedule();
    const a = make_system();
    const b = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, a, b);
    schedule.clear();

    expect(schedule.has_system(a)).toBe(false);
    expect(schedule.has_system(b)).toBe(false);
    expect(schedule.get_all_systems().length).toBe(0);
  });

  //=========================================================
  // Duplicate detection
  //=========================================================

  it("throws on duplicate system", () => {
    const schedule = new Schedule();
    const sys = make_system();

    schedule.add_systems(SCHEDULE.UPDATE, sys);
    expect(() => schedule.add_systems(SCHEDULE.UPDATE, sys)).toThrow();
  });

  //=========================================================
  // has_fixed_systems
  //=========================================================

  it("has_fixed_systems returns false when no systems registered", () => {
    const schedule = new Schedule();
    expect(schedule.has_fixed_systems()).toBe(false);
  });

  it("has_fixed_systems returns true after adding a system", () => {
    const schedule = new Schedule();
    const sys = make_system();
    schedule.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    expect(schedule.has_fixed_systems()).toBe(true);
  });

  it("has_fixed_systems returns false after removing the only system", () => {
    const schedule = new Schedule();
    const sys = make_system();
    schedule.add_systems(SCHEDULE.FIXED_UPDATE, sys);
    schedule.remove_system(sys);
    expect(schedule.has_fixed_systems()).toBe(false);
  });

  //=========================================================
  // Empty phases
  //=========================================================

  it("running empty phases does not throw", () => {
    const schedule = new Schedule();
    const ctx = make_ctx();

    expect(() => schedule.run_startup(ctx)).not.toThrow();
    expect(() => schedule.run_update(ctx, 0.016)).not.toThrow();
  });
});
