/***
 * World — Public ECS facade.
 *
 * Single entry point that composes Store (data), Schedule (execution),
 * and SystemContext (system interface) into a unified API. External code
 * interacts exclusively through World; systems receive a SystemContext
 * instead, preventing direct access to internals.
 *
 * Architecture: Facade pattern over an archetype-based ECS.
 * - Entities are generational IDs (no object allocation)
 * - Components are typed array columns grouped by archetype
 * - Queries are cached and live-updated as new archetypes appear
 * - Systems are plain functions scheduled across 7 lifecycle phases
 *
 * Usage:
 *
 *   const world = new World({ fixed_timestep: 1/50 });
 *
 *   // Record syntax (per-field type control)
 *   const Pos = world.register_component({ x: "f64", y: "f64" });
 *   const Health = world.register_component({ current: "i32", max: "i32" });
 *
 *   // Array shorthand (uniform type, defaults to "f64")
 *   const Vel = world.register_component(["vx", "vy"] as const);
 *
 *   const IsEnemy = world.register_tag();
 *
 *   const e = world.create_entity();
 *   world.add_component(e, Pos, { x: 0, y: 0 });
 *   world.add_component(e, Vel, { vx: 1, vy: 2 });
 *   world.add_component(e, IsEnemy);
 *
 *   const moveSys = world.register_system(
 *     (q, _ctx, dt) => {
 *       q.for_each((arch) => {
 *         const px = arch.get_column(Pos, "x");
 *         const py = arch.get_column(Pos, "y");
 *         const vx = arch.get_column(Vel, "vx");
 *         const vy = arch.get_column(Vel, "vy");
 *         for (let i = 0; i < arch.entity_count; i++) {
 *           px[i] += vx[i] * dt;
 *           py[i] += vy[i] * dt;
 *         }
 *       });
 *     },
 *     (qb) => qb.every(Pos, Vel),
 *   );
 *
 *   world.add_systems(SCHEDULE.UPDATE, moveSys);
 *   world.startup();
 *
 *   // game loop
 *   world.update(1 / 60);
 *
 ***/

import { Store } from "./store";
import { Schedule, type SCHEDULE } from "./schedule";
import type { Archetype } from "./archetype";
import {
  SystemContext,
  Query,
  QueryBuilder,
  type QueryResolver,
  type QueryCacheEntry,
} from "./query";
import type { EntityID } from "./entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  ComponentFields,
  FieldValues,
} from "./component";
import type { EventDef, EventKey, EventReader } from "./event";
import type { ResourceKey } from "./resource";
import { as_system_id, type SystemFn, type SystemConfig, type SystemDescriptor } from "./system";
import type { SystemEntry } from "./schedule";
import { BitSet, unsafe_cast, type TypedArrayTag } from "./type_primitives";
import { bucket_push } from "./utils/arrays";
import { ECSError, ECS_ERROR } from "./utils/error";
import {
  EMPTY_VALUES,
  DEFAULT_FIXED_TIMESTEP,
  DEFAULT_MAX_FIXED_STEPS,
  HASH_GOLDEN_RATIO,
  HASH_SECONDARY_PRIME,
} from "./utils/constants";

export interface WorldOptions {
  fixed_timestep?: number;
  max_fixed_steps?: number;
  initial_capacity?: number;
}

export class ECS implements QueryResolver {
  private readonly store: Store;
  private readonly schedule: Schedule;
  private readonly ctx: SystemContext;

  private readonly systems: Set<SystemDescriptor> = new Set();
  private next_system_id = 0;

  // Tick counter for change detection
  private _tick: number = 0;

  // Fixed timestep accumulator
  private _fixed_timestep: number;
  private _accumulator = 0;
  private _max_fixed_steps: number;

  // Query deduplication: hash(include, exclude, any_of) → bucket of cache entries.
  // Multiple queries can share the same hash (collision), so each bucket is an array.
  private readonly query_cache: Map<number, QueryCacheEntry[]> = new Map();
  // Reusable BitSet for building query masks — avoids allocation per query() call
  private readonly scratch_mask: BitSet = new BitSet();

  constructor(options?: WorldOptions) {
    this.store = new Store(options?.initial_capacity);
    this.schedule = new Schedule();
    this.ctx = new SystemContext(this.store);
    this._fixed_timestep = options?.fixed_timestep ?? DEFAULT_FIXED_TIMESTEP;
    this._max_fixed_steps = options?.max_fixed_steps ?? DEFAULT_MAX_FIXED_STEPS;
  }

  public get fixed_timestep(): number {
    return this._fixed_timestep;
  }

  public set fixed_timestep(value: number) {
    this._fixed_timestep = value;
  }

  public get fixed_alpha(): number {
    return this._accumulator / this._fixed_timestep;
  }

  // Overload 1: record syntax (per-field types)
  public register_component<S extends Record<string, TypedArrayTag>>(schema: S): ComponentDef<S>;
  // Overload 2: array shorthand (uniform type, defaults to "f64")
  public register_component<const F extends readonly string[], T extends TypedArrayTag = "f64">(
    fields: F,
    type?: T,
  ): ComponentDef<{ readonly [K in F[number]]: T }>;
  // Implementation
  public register_component(
    schema_or_fields: Record<string, TypedArrayTag> | readonly string[],
    type?: TypedArrayTag,
  ): ComponentDef<any> {
    if (Array.isArray(schema_or_fields)) {
      const t = type ?? "f64";
      const schema: Record<string, TypedArrayTag> = Object.create(null);
      for (const f of schema_or_fields) schema[f] = t;
      return this.store.register_component(schema);
    }
    return this.store.register_component(schema_or_fields as Record<string, TypedArrayTag>);
  }

  public register_tag(): ComponentDef<Record<string, never>> {
    return this.store.register_component({} as Record<string, never>);
  }

  public register_event<F extends readonly string[]>(key: EventKey<F>, fields: F): void {
    this.store.register_event_by_key(key, fields);
  }

  public register_signal(key: EventKey<readonly []>): void {
    this.store.register_event_by_key(key, [] as unknown as readonly string[]);
  }

  public register_resource<T>(key: ResourceKey<T>, value: T): void {
    this.store.register_resource(key, value);
  }

  public resource<T>(key: ResourceKey<T>): T {
    return unsafe_cast<T>(this.store.get_resource(key));
  }

  public set_resource<T>(key: ResourceKey<T>, value: T): void {
    this.store.set_resource(key, value);
  }

  public has_resource<T>(key: ResourceKey<T>): boolean {
    return this.store.has_resource(key);
  }

  public create_entity(): EntityID {
    return this.store.create_entity();
  }

  public destroy_entity_deferred(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  public is_alive(id: EntityID): boolean {
    return this.store.is_alive(id);
  }

  public get entity_count(): number {
    return this.store.entity_count;
  }

  public add_component(entity_id: EntityID, def: ComponentDef<Record<string, never>>): this;
  public add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: FieldValues<S>,
  ): this;
  public add_component(
    entity_id: EntityID,
    def: ComponentDef,
    values?: Record<string, number>,
  ): this {
    this.store.add_component(entity_id, def, values ?? EMPTY_VALUES);
    return this;
  }

  public add_components(
    entity_id: EntityID,
    entries: {
      def: ComponentDef;
      values?: Record<string, number>;
    }[],
  ): void {
    this.store.add_components(entity_id, entries);
  }

  public remove_component(entity_id: EntityID, def: ComponentDef): this {
    this.store.remove_component(entity_id, def);
    return this;
  }

  public remove_components(entity_id: EntityID, ...defs: ComponentDef[]): void {
    this.store.remove_components(entity_id, defs);
  }

  public has_component(entity_id: EntityID, def: ComponentDef): boolean {
    return this.store.has_component(entity_id, def);
  }

  /**
   * Bulk add a component to ALL entities in the given archetype.
   * O(columns) via TypedArray.set() instead of O(N×columns).
   */
  public batch_add_component(src_arch: Archetype, def: ComponentDef<Record<string, never>>): void;
  public batch_add_component<S extends ComponentSchema>(
    src_arch: Archetype,
    def: ComponentDef<S>,
    values: FieldValues<S>,
  ): void;
  public batch_add_component(
    src_arch: Archetype,
    def: ComponentDef,
    values?: Record<string, number>,
  ): void {
    this.store.batch_add_component(src_arch, def, values);
  }

  /**
   * Bulk remove a component from ALL entities in the given archetype.
   * O(columns) via TypedArray.set() instead of O(N×columns).
   */
  public batch_remove_component(src_arch: Archetype, def: ComponentDef): void {
    this.store.batch_remove_component(src_arch, def);
  }

  public get_field<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    field: string & keyof S,
  ): number {
    if (__DEV__) {
      if (!this.store.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    }
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    return arch.read_field(row, def as unknown as ComponentID, field);
  }

  public set_field<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    field: string & keyof S,
    value: number,
  ): void {
    if (__DEV__) {
      if (!this.store.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    }
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    const col = arch.get_column_mut(def, field, this.store._tick);
    col[row] = value;
  }

  public emit(key: EventKey<readonly []>): void;
  public emit<F extends ComponentFields>(
    key: EventKey<F>,
    values: { readonly [K in F[number]]: number },
  ): void;
  public emit(key: EventKey<ComponentFields>, values?: Record<string, number>): void {
    const def = this.store.get_event_def_by_key(key);
    if (values === undefined) {
      this.store.emit_signal(def as EventDef<readonly []>);
    } else {
      this.store.emit_event(def, values);
    }
  }

  public read<F extends ComponentFields>(key: EventKey<F>): EventReader<F> {
    const def = this.store.get_event_def_by_key(key);
    return this.store.get_event_reader(def) as EventReader<F>;
  }

  public query<T extends ComponentDef[]>(...defs: T): Query<T> {
    // Reuse scratch_mask to avoid allocating a new BitSet per query call.
    // Zero it out, set bits, then copy for the cache key.
    const mask = this.scratch_mask;
    mask._words.fill(0);
    for (let i = 0; i < defs.length; i++) {
      mask.set(defs[i] as unknown as number);
    }
    return this._resolve_query(mask.copy(), null, null, defs);
  }

  public _get_last_run_tick(): number {
    return this.ctx.last_run_tick;
  }

  /** QueryResolver implementation — creates or retrieves a cached Query. */
  public _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef[],
  ): Query<any> {
    // Combine three hashes into one cache key using xor with golden-ratio
    // multipliers to reduce collision probability between masks
    const inc_hash = include.hash();
    const exc_hash = exclude ? exclude.hash() : 0;
    const any_hash = any_of ? any_of.hash() : 0;
    const key =
      (inc_hash ^
        Math.imul(exc_hash, HASH_GOLDEN_RATIO) ^
        Math.imul(any_hash, HASH_SECONDARY_PRIME)) |
      0;

    const cached = this._find_cached(key, include, exclude, any_of);
    if (cached !== undefined) return cached.query;

    // Store.register_query returns a live Archetype[] that the Store will
    // push new matching archetypes into as they are created
    const result = this.store.register_query(include, exclude ?? undefined, any_of ?? undefined);
    const q = new Query(
      result,
      defs as ComponentDef[],
      this,
      include.copy(),
      exclude?.copy() ?? null,
      any_of?.copy() ?? null,
    );
    this.store.update_query_ref(result, q);
    bucket_push(this.query_cache, key, {
      include_mask: include.copy(),
      exclude_mask: exclude?.copy() ?? null,
      any_of_mask: any_of?.copy() ?? null,
      query: q,
    });
    return q;
  }

  private _find_cached(
    key: number,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ): QueryCacheEntry | undefined {
    const bucket = this.query_cache.get(key);
    if (!bucket) return undefined;
    // Linear scan within the bucket — buckets are typically 1-2 entries
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i];
      if (!e.include_mask.equals(include)) continue;
      const exc_ok =
        exclude === null
          ? e.exclude_mask === null
          : e.exclude_mask !== null && e.exclude_mask.equals(exclude);
      if (!exc_ok) continue;
      const any_ok =
        any_of === null
          ? e.any_of_mask === null
          : e.any_of_mask !== null && e.any_of_mask.equals(any_of);
      if (!any_ok) continue;
      return e;
    }
    return undefined;
  }

  /**
   * Register a system.
   *
   *   // Bare function (no query, no lifecycle hooks)
   *   world.register_system((ctx, dt) => { ... });
   *
   *   // Function + query builder
   *   world.register_system(
   *     (q, ctx, dt) => { q.for_each((arch) => { ... }); },
   *     (qb) => qb.every(Pos, Vel),
   *   );
   *
   *   // Full config (for lifecycle hooks)
   *   world.register_system({ fn(ctx, dt) { ... } });
   */
  public register_system(fn: SystemFn): SystemDescriptor;
  public register_system<Defs extends readonly ComponentDef[]>(
    fn: (q: Query<Defs>, ctx: SystemContext, dt: number) => void,
    query_fn: (qb: QueryBuilder) => Query<Defs>,
  ): SystemDescriptor;
  public register_system(config: SystemConfig): SystemDescriptor;
  // any: overload implementation must unify bare fn, (fn, query_fn), and SystemConfig
  public register_system(
    fn_or_config:
      | ((q: Query<any>, ctx: SystemContext, dt: number) => void)
      | SystemFn
      | SystemConfig,
    query_fn?: (qb: QueryBuilder) => Query<any>,
  ): SystemDescriptor {
    let config: SystemConfig;

    if (typeof fn_or_config === "function") {
      if (query_fn !== undefined) {
        // (fn, query_fn) overload — resolve query at registration time
        const q = query_fn(new QueryBuilder(this));
        const ctx = this.ctx;
        const fn = fn_or_config as (q: Query<any>, ctx: SystemContext, dt: number) => void;
        config = { fn: (_ctx, dt) => fn(q, ctx, dt) };
      } else {
        // Bare function overload
        config = { fn: fn_or_config as SystemFn };
      }
    } else {
      config = fn_or_config as SystemConfig;
    }

    const id = as_system_id(this.next_system_id++);
    const descriptor: SystemDescriptor = Object.freeze(Object.assign({ id }, config));
    this.systems.add(descriptor);
    return descriptor;
  }

  public add_systems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): this {
    this.schedule.add_systems(label, ...entries);
    return this;
  }

  public remove_system(system: SystemDescriptor): void {
    this.schedule.remove_system(system);
    system.on_removed?.();
    this.systems.delete(system);
  }

  public get system_count(): number {
    return this.systems.size;
  }

  public startup(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.on_added?.(this.ctx);
    }
    this.schedule.run_startup(this.ctx, this._tick);
  }

  public update(dt: number): void {
    this.store._tick = this._tick;

    if (this.schedule.has_fixed_systems()) {
      this._accumulator += dt;
      const max_acc = this._max_fixed_steps * this._fixed_timestep;
      if (this._accumulator > max_acc) {
        this._accumulator = max_acc;
      }
      while (this._accumulator >= this._fixed_timestep) {
        this.schedule.run_fixed_update(this.ctx, this._fixed_timestep, this._tick);
        this._accumulator -= this._fixed_timestep;
      }
    }

    this.schedule.run_update(this.ctx, dt, this._tick);
    this.store.clear_events();
    this._tick++;
  }

  public flush(): void {
    this.ctx.flush();
  }

  public dispose(): void {
    for (const descriptor of this.systems.values()) {
      descriptor.dispose?.();
      descriptor.on_removed?.();
    }
    this.systems.clear();
    this.schedule.clear();
  }
}
