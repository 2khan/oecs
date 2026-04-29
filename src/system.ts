/***
 * System — Function-based system types.
 *
 * Systems are plain functions, not classes. A SystemConfig defines the
 * system's update function and optional lifecycle hooks.
 * World.register_system() assigns a unique SystemID and returns a frozen
 * SystemDescriptor — the identity handle used for scheduling and ordering.
 *
 * Lifecycle:
 *   on_added(ctx)    — called once during world.startup()
 *   fn(ctx, dt)      — called every frame by the schedule
 *   on_removed()     — called when the system is unregistered
 *   dispose()        — called during world.dispose()
 *
 ***/

import { Brand, validate_and_cast, is_non_negative_integer } from "./type_primitives";
import type { SystemContext } from "./query";

export type SystemID = Brand<number, "system_id">;

export const as_system_id = (value: number) =>
  validate_and_cast<number, SystemID>(
    value,
    is_non_negative_integer,
    "SystemID must be a non-negative integer",
  );

/**
 * The signature of a system's per-frame function. Receives the
 * {@link SystemContext} (deferred-mutation handle, resources, events)
 * plus the delta time in seconds for the current phase.
 */
export type SystemFn = (ctx: SystemContext, delta_time: number) => void;

/**
 * Full configuration for a registered system. Pass to
 * {@link ECS.register_system} when you need lifecycle hooks; otherwise
 * pass a bare {@link SystemFn}.
 */
export interface SystemConfig {
  /** Per-frame function. Called once per phase invocation. */
  fn: SystemFn;
  /** Optional human-readable name; surfaces in cycle-detection errors. */
  name?: string;
  /** Called once during {@link ECS.startup}, before any phase runs. */
  on_added?: (ctx: SystemContext) => void;
  /** Called when the system is removed via {@link ECS.remove_system}. */
  on_removed?: () => void;
  /** Called once during {@link ECS.dispose}, before {@link SystemConfig.on_removed}. */
  dispose?: () => void;
}

/**
 * Frozen identity handle returned by {@link ECS.register_system}. Used
 * for scheduling ({@link ECS.add_systems}), ordering constraints
 * ({@link SystemOrdering}), and removal ({@link ECS.remove_system}).
 */
export interface SystemDescriptor extends Readonly<SystemConfig> {
  /** Stable per-world ID assigned at registration. */
  readonly id: SystemID;
}
