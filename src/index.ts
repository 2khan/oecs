/**
 * # oecs
 *
 * Archetype-based Entity Component System for TypeScript.
 *
 * Entities are generational integer IDs. Components are SoA-packed typed
 * arrays grouped by archetype. Queries are cached, live-updated as new
 * archetypes appear, and iterate archetype-by-archetype for cache-friendly
 * inner loops. Systems are plain functions scheduled across seven
 * lifecycle phases with topological ordering.
 *
 * ## Install
 *
 * ```sh
 * deno add jsr:@oasys/oecs
 * # or
 * npx jsr add @oasys/oecs
 * # or
 * pnpm dlx jsr add @oasys/oecs
 * ```
 *
 * ## Quick start
 *
 * ```ts
 * import { ECS, SCHEDULE } from "@oasys/oecs";
 *
 * const world = new ECS({ fixed_timestep: 1 / 50 });
 *
 * // Record syntax (per-field type control)
 * const Pos = world.register_component({ x: "f64", y: "f64" });
 *
 * // Array shorthand (uniform type, defaults to "f64")
 * const Vel = world.register_component(["vx", "vy"] as const);
 *
 * // Tag (no data, archetype marker only)
 * const IsEnemy = world.register_tag();
 *
 * const e = world.create_entity();
 * world.add_component(e, Pos, { x: 0, y: 0 });
 * world.add_component(e, Vel, { vx: 1, vy: 2 });
 * world.add_component(e, IsEnemy);
 *
 * const move = world.register_system(
 *   (q, _ctx, dt) => {
 *     q.for_each((arch) => {
 *       const px = arch.get_column(Pos, "x");
 *       const py = arch.get_column(Pos, "y");
 *       const vx = arch.get_column(Vel, "vx");
 *       const vy = arch.get_column(Vel, "vy");
 *       for (let i = 0; i < arch.entity_count; i++) {
 *         px[i] += vx[i] * dt;
 *         py[i] += vy[i] * dt;
 *       }
 *     });
 *   },
 *   (qb) => qb.every(Pos, Vel),
 * );
 *
 * world.add_systems(SCHEDULE.UPDATE, move);
 * world.startup();
 *
 * // game loop
 * world.update(1 / 60);
 * ```
 *
 * ## Concepts
 *
 * - **{@link ECS}** — the world facade. Owns entities, components,
 *   resources, events, and the system schedule.
 * - **{@link Query}** — a live, cached view over archetypes matching a
 *   component mask. Compose with {@link Query.and | and},
 *   {@link Query.not | not}, {@link Query.any_of | any_of}, and
 *   {@link Query.changed | changed}.
 * - **{@link SystemContext}** — the handle systems receive. Exposes only
 *   deferred mutations (changes are buffered until the phase flush) plus
 *   resource and event access.
 * - **{@link SCHEDULE}** — seven execution phases. Startup runs once;
 *   update phases run every frame; fixed_update runs at a fixed timestep.
 * - **Resources** ({@link resource_key}, {@link ResourceKey}) — typed
 *   global singletons.
 * - **Events** ({@link event_key}, {@link signal_key},
 *   {@link EventKey}, {@link EventReader}) — fire-and-forget messages
 *   auto-cleared at end of frame.
 *
 * @module oecs
 */

export { ECS, type WorldOptions } from "./ecs";

export { SCHEDULE, type SystemEntry, type SystemOrdering } from "./schedule";

export { SystemContext } from "./query";
export type { SystemFn, SystemConfig, SystemDescriptor } from "./system";

export type { ComponentRef, ReadonlyComponentRef } from "./ref";

export { Query, QueryBuilder, ChangedQuery } from "./query";

export type { EntityID } from "./entity";

export type {
  ComponentDef,
  ComponentSchema,
  ComponentFields,
  FieldValues,
  TagToTypedArray,
  ColumnsForSchema,
  ReadonlyColumn,
  ReadonlyUint32Array,
} from "./component";

export type { EventReader, EventKey } from "./event";
export { event_key, signal_key } from "./event";

export type { ResourceKey } from "./resource";
export { resource_key } from "./resource";
