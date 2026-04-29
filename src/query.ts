/***
 * Query, QueryBuilder, SystemContext — System-facing ECS interface.
 *
 * Query<Defs> is a live, cached view over all archetypes matching a
 * component mask. Iterate with for_each(), which yields non-empty
 * archetypes. Use arch.get_column() to access SoA columns, then
 * write the inner loop over arch.entity_count.
 *
 * QueryBuilder is the entry point for creating queries inside
 * register_system(fn, qb => qb.every(Pos, Vel)).
 *
 * SystemContext wraps Store for use inside system functions, exposing
 * only deferred operations (add/remove component, destroy entity) that
 * buffer changes until the phase flush. This prevents iterator
 * invalidation during system execution.
 *
 * Usage (inside a system):
 *
 *   q.for_each((arch) => {
 *     const px = arch.get_column(Pos, "x");
 *     const py = arch.get_column(Pos, "y");
 *     const vx = arch.get_column(Vel, "vx");
 *     const vy = arch.get_column(Vel, "vy");
 *     for (let i = 0; i < arch.entity_count; i++) {
 *       px[i] += vx[i] * dt;
 *       py[i] += vy[i] * dt;
 *     }
 *   });
 *
 * Queries compose via chaining:
 *
 *   q.and(Health)          — extend required components
 *   q.not(Dead)            — exclude archetypes with Dead
 *   q.any_of(Poison, Fire) — require at least one of these
 *
 ***/

import type { Store } from "./store";
import type { Archetype } from "./archetype";
import type { EntityID } from "./entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  ComponentFields,
  FieldValues,
} from "./component";
import { create_ref, type ComponentRef, type ReadonlyComponentRef } from "./ref";
import type { EventDef, EventKey, EventReader } from "./event";
import type { ResourceKey } from "./resource";
import { BitSet, unsafe_cast } from "./type_primitives";
import { EMPTY_VALUES } from "./utils/constants";
import { ECSError, ECS_ERROR } from "./utils/error";

export interface QueryCacheEntry {
  include_mask: BitSet;
  exclude_mask: BitSet | null;
  any_of_mask: BitSet | null;
  query: Query<any>; // any: heterogeneous cache — different queries have different Defs tuples
}

export interface QueryResolver {
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef[],
  ): Query<any>; // any: heterogeneous cache — callers downcast to their specific Query<Defs>
  _get_last_run_tick(): number;
}

/**
 * A live, cached view over all archetypes matching a component mask.
 *
 * Iterate with {@link Query.for_each} — the callback fires once per
 * non-empty matching archetype. Inside the callback, fetch SoA columns
 * with `arch.get_column(Def, "field")` and run the tight inner loop over
 * `arch.entity_count`.
 *
 * Compose larger queries by chaining: {@link Query.and},
 * {@link Query.not}, {@link Query.any_of}, {@link Query.changed}.
 * Each composition is itself cached, so repeated calls return the same
 * Query instance.
 *
 * @typeParam Defs - Tuple of component definitions in the include mask;
 *   used by tooling to type-check the components fetched from archetypes.
 *
 * @example
 * ```ts
 * world.register_system(
 *   (q) => q.for_each((arch) => {
 *     const px = arch.get_column(Pos, "x");
 *     const vx = arch.get_column(Vel, "vx");
 *     for (let i = 0; i < arch.entity_count; i++) px[i] += vx[i];
 *   }),
 *   (qb) => qb.every(Pos, Vel).not(Frozen),
 * );
 * ```
 */
export class Query<Defs extends readonly ComponentDef[]> {
  private readonly _archetypes: Archetype[];
  private readonly _defs: Defs;
  private readonly _resolver: QueryResolver;
  /** @internal */
  public readonly _include: BitSet;
  private readonly _exclude: BitSet | null;
  private readonly _any_of: BitSet | null;
  private _non_empty_archetypes: Archetype[] = [];
  private _non_empty_dirty: boolean = true;
  // Per-Query composition caches — single-component fast path.
  // The final Query produced by _resolve_query is already cached by the
  // resolver, but the caller pays a BitSet copy + defs slice per call
  // before the resolver can hash and hit that cache. These caches
  // short-circuit that allocation path for the common single-component
  // composition shape (q.and(X), q.changed(X), etc).
  private _and_cache_single: Map<number, Query<any>> | null = null;
  private _not_cache_single: Map<number, Query<any>> | null = null;
  private _any_of_cache_single: Map<number, Query<any>> | null = null;
  private _changed_cache_single: Map<number, ChangedQuery<any>> | null = null;

  constructor(
    archetypes: Archetype[],
    defs: Defs,
    resolver: QueryResolver,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ) {
    this._archetypes = archetypes;
    this._defs = defs;
    this._resolver = resolver;
    this._include = include;
    this._exclude = exclude;
    this._any_of = any_of;
  }

  /** Number of matching archetypes (including empty ones). */
  public get archetype_count(): number {
    return this._archetypes.length;
  }

  /** Total entity count across all matching archetypes. */
  public count(): number {
    const archs = this._archetypes;
    let total = 0;
    for (let i = 0; i < archs.length; i++) total += archs[i].entity_count;
    return total;
  }

  /** @internal */
  public get archetypes(): readonly Archetype[] {
    return this._archetypes;
  }

  /**
   * Extend the include mask with additional components. Returns a new,
   * cached Query — calling `.and(C)` repeatedly on the same query is
   * effectively free.
   */
  public and<D extends ComponentDef[]>(...comps: D): Query<[...Defs, ...D]> {
    // Fast path: single-component composition (common shape, e.g. q.and(Dead)).
    // Skip BitSet/defs allocations when we already have a cached child.
    if (comps.length === 1) {
      const cid = comps[0] as unknown as number;
      const cache = this._and_cache_single;
      if (cache !== null) {
        const hit = cache.get(cid);
        if (hit !== undefined) return hit;
      }
      const new_include = this._include.copy();
      const new_defs = this._defs.slice() as ComponentDef[];
      if (!new_include.has(cid)) {
        new_include.set(cid);
        new_defs.push(comps[0]);
      }
      const q = this._resolver._resolve_query(new_include, this._exclude, this._any_of, new_defs);
      (this._and_cache_single ??= new Map()).set(cid, q);
      return q;
    }
    const new_include = this._include.copy();
    const new_defs = this._defs.slice() as ComponentDef[];
    for (let i = 0; i < comps.length; i++) {
      if (!new_include.has(comps[i] as number)) {
        new_include.set(comps[i] as number);
        new_defs.push(comps[i]);
      }
    }
    return this._resolver._resolve_query(new_include, this._exclude, this._any_of, new_defs);
  }

  /**
   * Exclude archetypes that have **any** of these components. Returns a
   * new, cached Query.
   *
   * @example
   * ```ts
   * qb.every(Pos, Vel).not(Dead, Frozen)
   * ```
   */
  public not(...comps: ComponentDef[]): Query<Defs> {
    if (comps.length === 1) {
      const cid = comps[0] as unknown as number;
      const cache = this._not_cache_single;
      if (cache !== null) {
        const hit = cache.get(cid);
        if (hit !== undefined) return hit as Query<Defs>;
      }
      const new_exclude = this._exclude ? this._exclude.copy() : new BitSet();
      new_exclude.set(cid);
      const q = this._resolver._resolve_query(
        this._include,
        new_exclude,
        this._any_of,
        this._defs,
      ) as Query<Defs>;
      (this._not_cache_single ??= new Map()).set(cid, q);
      return q;
    }
    const new_exclude = this._exclude ? this._exclude.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_exclude.set(comps[i] as number);
    return this._resolver._resolve_query(
      this._include,
      new_exclude,
      this._any_of,
      this._defs,
    ) as Query<Defs>;
  }

  /**
   * Iterate over every non-empty matching archetype. Inside the callback,
   * fetch SoA columns from the archetype and run the inner loop.
   *
   * The `Defs` generic is preserved so `arch.get_column(Def, "field")` is
   * type-safe for components in the include mask.
   */
  public for_each(cb: (arch: Archetype) => void): void {
    const archs = this._non_empty();
    for (let i = 0; i < archs.length; i++) {
      cb(archs[i]);
    }
  }

  /** @internal — called by Store after flush and archetype push. */
  public mark_non_empty_dirty(): void {
    this._non_empty_dirty = true;
  }

  /** @internal — used by ChangedQuery. Rebuild non-empty archetype list if dirty, return cached result. */
  public _non_empty(): Archetype[] {
    if (this._non_empty_dirty) {
      const src = this._archetypes;
      const dst = this._non_empty_archetypes;
      dst.length = 0;
      for (let i = 0; i < src.length; i++) {
        if (src[i].entity_count > 0) dst.push(src[i]);
      }
      this._non_empty_dirty = false;
    }
    return this._non_empty_archetypes;
  }

  /**
   * Require **at least one** of the given components in addition to the
   * include mask. Use to express "either X or Y" without expanding into
   * multiple queries.
   */
  public any_of(...comps: ComponentDef[]): Query<Defs> {
    if (comps.length === 1) {
      const cid = comps[0] as unknown as number;
      const cache = this._any_of_cache_single;
      if (cache !== null) {
        const hit = cache.get(cid);
        if (hit !== undefined) return hit as Query<Defs>;
      }
      const new_any_of = this._any_of ? this._any_of.copy() : new BitSet();
      new_any_of.set(cid);
      const q = this._resolver._resolve_query(
        this._include,
        this._exclude,
        new_any_of,
        this._defs,
      ) as Query<Defs>;
      (this._any_of_cache_single ??= new Map()).set(cid, q);
      return q;
    }
    const new_any_of = this._any_of ? this._any_of.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_any_of.set(comps[i] as number);
    return this._resolver._resolve_query(
      this._include,
      this._exclude,
      new_any_of,
      this._defs,
    ) as Query<Defs>;
  }

  /**
   * Wrap this query in a {@link ChangedQuery} that yields only archetypes
   * whose change tick on at least one of the named components is at or
   * after the system's last run tick.
   *
   * Components passed to `changed()` must already be in the include mask.
   *
   * @example
   * ```ts
   * (qb) => qb.every(Pos, Vel).changed(Pos)
   * ```
   */
  public changed(...defs: ComponentDef[]): ChangedQuery<Defs> {
    if (defs.length === 1) {
      const cid = defs[0] as unknown as number;
      const cache = this._changed_cache_single;
      if (cache !== null) {
        const hit = cache.get(cid);
        if (hit !== undefined) return hit as ChangedQuery<Defs>;
      }
      const cq = new ChangedQuery<Defs>(this, [cid]);
      (this._changed_cache_single ??= new Map()).set(cid, cq);
      return cq;
    }
    const ids: number[] = new Array(defs.length);
    for (let i = 0; i < defs.length; i++) ids[i] = defs[i] as unknown as number;
    return new ChangedQuery(this, ids);
  }

  /** @internal — reads last_run_tick from the resolver (ECS). */
  public _ctx_last_run_tick(): number {
    return this._resolver._get_last_run_tick();
  }
}

/**
 * Entry point for building a {@link Query} from inside `register_system`.
 *
 * Receives the world implicitly; use {@link QueryBuilder.every} as the
 * starting node and chain {@link Query.and}, {@link Query.not},
 * {@link Query.any_of}, {@link Query.changed} for further refinement.
 *
 * @example
 * ```ts
 * world.register_system(fn, (qb) => qb.every(Pos, Vel).not(Frozen));
 * ```
 */
export class QueryBuilder {
  constructor(private readonly _resolver: QueryResolver) {}

  /**
   * Start a query that matches archetypes containing **all** of the given
   * components.
   */
  public every<T extends ComponentDef[]>(...defs: T): Query<T> {
    const mask = new BitSet();
    for (let i = 0; i < defs.length; i++) mask.set(defs[i] as number);
    return this._resolver._resolve_query(mask, null, null, defs);
  }
}

/**
 * The handle a system receives. Wraps the world's storage with
 * deferred-only structural mutations: changes are buffered and applied at
 * the next phase flush, so iterators stay valid for the duration of the
 * system.
 *
 * Resource and event APIs mirror {@link ECS}; structural APIs
 * ({@link SystemContext.destroy_entity}, {@link SystemContext.add_component},
 * {@link SystemContext.remove_component}) buffer rather than apply.
 *
 * Use {@link SystemContext.ref} / {@link SystemContext.ref_mut} for
 * cached single-entity field access — useful when a system inspects a
 * specific entity (e.g. a player) rather than iterating archetypes.
 */
export class SystemContext {
  /** @internal */
  public readonly store: Store;
  /** @internal */
  public last_run_tick: number = 0;

  /**
   * The current world tick — monotonically increasing counter, advanced
   * once per {@link ECS.update} call. Useful for change-tick comparisons.
   */
  public get world_tick(): number {
    return this.store._tick;
  }

  constructor(store: Store) {
    this.store = store;
  }

  /** Create a new entity. Available immediately (not deferred). */
  public create_entity(): EntityID {
    return this.store.create_entity();
  }

  /** Read a single field from a component on a single entity. */
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
    return arch.read_field(row, def as ComponentID, field);
  }

  /**
   * Write a single field on a component for a single entity. Marks the
   * component as changed for {@link Query.changed} detection.
   */
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

  /**
   * Create a cached read-only reference to a single entity's component.
   * The archetype + row + column lookup happens once; subsequent field
   * reads are a single typed-array index. Safe inside systems because
   * structural changes are deferred — the entity cannot move archetypes
   * before the next flush.
   *
   * @example
   * ```ts
   * const pos = ctx.ref(Pos, e);
   * console.log(pos.x, pos.y);
   * ```
   */
  public ref<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
  ): ReadonlyComponentRef<S> {
    if (__DEV__) {
      if (!this.store.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    }
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    // ! safe: column_groups is populated for all components with fields in this archetype
    return create_ref<S>(arch.column_groups[def as unknown as number]!, row);
  }

  /**
   * Create a cached **mutable** reference to a single entity's component.
   * Marks the component as changed at creation time, so subsequent writes
   * via the ref are visible to {@link Query.changed} consumers in the
   * same frame.
   */
  public ref_mut<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
  ): ComponentRef<S> {
    if (__DEV__) {
      if (!this.store.is_alive(entity_id)) throw new ECSError(ECS_ERROR.ENTITY_NOT_ALIVE);
    }
    const arch = this.store.get_entity_archetype(entity_id);
    const row = this.store.get_entity_row(entity_id);
    arch._changed_tick[def as unknown as number] = this.store._tick;
    // ! safe: column_groups is populated for all components with fields in this archetype
    return create_ref<S>(arch.column_groups[def as unknown as number]!, row);
  }

  /**
   * Buffer an entity for destruction. Applied at the next phase flush.
   * Idempotent — repeated calls within a frame are safe.
   */
  public destroy_entity(id: EntityID): this {
    this.store.destroy_entity_deferred(id);
    return this;
  }

  /**
   * Buffer a component addition. The entity moves archetypes at the next
   * phase flush. For tag components, omit `values`.
   */
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
    this.store.add_component_deferred(entity_id, def, values ?? EMPTY_VALUES);
    return this;
  }

  /**
   * Buffer a component removal. The entity moves archetypes at the next
   * phase flush.
   */
  public remove_component(entity_id: EntityID, def: ComponentDef): this {
    this.store.remove_component_deferred(entity_id, def);
    return this;
  }

  /**
   * Apply all buffered structural changes (additions and removals first,
   * then destructions). The schedule calls this automatically between
   * phases — invoke manually only when interleaving deferred and immediate
   * code outside a phase.
   */
  public flush(): void {
    this.store.flush_structural();
    this.store.flush_destroyed();
  }

  // =======================================================
  // Events
  // =======================================================

  /**
   * Emit an event or signal. For zero-field signals, omit `values`. The
   * event is readable within the current frame and auto-cleared at end of
   * frame.
   */
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

  /**
   * Obtain a reader over an event channel — exposes a `.length` and one
   * column array per registered field.
   */
  public read<F extends ComponentFields>(key: EventKey<F>): EventReader<F> {
    const def = this.store.get_event_def_by_key(key);
    return this.store.get_event_reader(def) as EventReader<F>;
  }

  // =======================================================
  // Resources
  // =======================================================

  /**
   * Read a resource by key. Throws in development if the key has not been
   * registered.
   */
  public resource<T>(key: ResourceKey<T>): T {
    return unsafe_cast<T>(this.store.get_resource(key));
  }

  /** Replace the stored value for a resource. */
  public set_resource<T>(key: ResourceKey<T>, value: T): void {
    this.store.set_resource(key, value);
  }

  /** True if a resource has been registered for the given key. */
  public has_resource<T>(key: ResourceKey<T>): boolean {
    return this.store.has_resource(key);
  }
}

/**
 * A {@link Query} wrapper that filters archetypes by per-component change
 * tick — yields only archetypes whose change tick on at least one of the
 * named components is at or after the system's last run tick.
 *
 * Returned by {@link Query.changed}. The named components must already be
 * in the parent query's include mask (enforced in development).
 */
export class ChangedQuery<Defs extends readonly ComponentDef[]> {
  private readonly _query: Query<Defs>;
  private readonly _changed_ids: number[];

  constructor(query: Query<Defs>, changed_ids: number[]) {
    this._query = query;
    this._changed_ids = changed_ids;
    if (__DEV__) {
      for (let i = 0; i < changed_ids.length; i++) {
        if (!query._include.has(changed_ids[i])) {
          throw new ECSError(
            ECS_ERROR.COMPONENT_NOT_REGISTERED,
            `changed() component ${changed_ids[i]} is not in query's include mask`,
          );
        }
      }
    }
  }

  /**
   * Iterate over archetypes whose tracked components changed since the
   * system last ran. Inside the callback, fetch columns and run the inner
   * loop just like {@link Query.for_each}.
   */
  public for_each(cb: (arch: Archetype) => void): void {
    const last_tick = this._query._ctx_last_run_tick();
    const archs = this._query._non_empty();
    const ids = this._changed_ids;
    for (let i = 0; i < archs.length; i++) {
      const arch = archs[i];
      for (let j = 0; j < ids.length; j++) {
        if (arch._changed_tick[ids[j]] >= last_tick) {
          cb(arch);
          break;
        }
      }
    }
  }
}
