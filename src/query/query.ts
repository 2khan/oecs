/***
 *
 * SystemContext - Store wrapper passed to every system function.
 * Provides cached query() for archetype matching and deferred structural changes.
 * See docs/DESIGN.md [opt:6, opt:7] for query performance design.
 *
 ***/

import type { Store } from "../store/store";
import type { Archetype } from "../archetype/archetype";
import type { EntityID } from "../entity/entity";
import { get_entity_index } from "../entity/entity";
import type {
  ComponentDef,
  ComponentID,
  ComponentSchema,
  SchemaValues,
} from "../component/component";
import type { ColumnsForSchema } from "../component/component";
import { BitSet } from "type_primitives";
import { bucket_push } from "../utils/arrays";

//=========================================================
// Type utilities
//=========================================================

type SchemaOf<D> = D extends ComponentDef<infer S> ? S : never;

type DefsToColumns<Defs extends readonly ComponentDef<ComponentSchema>[]> = {
  [I in keyof Defs]: ColumnsForSchema<SchemaOf<Defs[I]>>
};

type EachFn<Defs extends readonly ComponentDef<ComponentSchema>[]> =
  (...args: [...DefsToColumns<Defs>, number]) => void;

//=========================================================
// Cache entry
//=========================================================

interface QueryCacheEntry {
  include_mask: BitSet;
  exclude_mask: BitSet | null;
  any_of_mask:  BitSet | null;
  query: Query<any>;
}

//=========================================================
// Query<Defs>
//=========================================================

export class Query<Defs extends readonly ComponentDef<ComponentSchema>[]> {
  private readonly _archetypes: Archetype[];
  private readonly _defs: Defs;
  readonly _ctx: SystemContext;
  readonly _include: BitSet;
  readonly _exclude: BitSet | null;
  readonly _any_of: BitSet | null;
  private readonly _args_buf: unknown[]; // pre-allocated: defs.length + 1 slots

  constructor(
    archetypes: Archetype[],
    defs: Defs,
    ctx: SystemContext,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ) {
    this._archetypes = archetypes;
    this._defs = defs;
    this._ctx = ctx;
    this._include = include;
    this._exclude = exclude;
    this._any_of = any_of;
    this._args_buf = new Array(defs.length + 1);
  }

  // Compat getters / iterability
  get length(): number { return this._archetypes.length; }
  get archetypes(): readonly Archetype[] { return this._archetypes; }
  [Symbol.iterator](): Iterator<Archetype> {
    return this._archetypes[Symbol.iterator]();
  }

  /** Typed per-archetype iteration — one closure call per archetype, not per entity. */
  each(fn: EachFn<Defs>): void {
    const archs = this._archetypes;
    const defs  = this._defs;
    const buf   = this._args_buf;
    for (let ai = 0; ai < archs.length; ai++) {
      const arch = archs[ai];
      const count = arch.entity_count;
      if (count === 0) continue;
      for (let di = 0; di < defs.length; di++) {
        buf[di] = arch.get_column_group(defs[di]);
      }
      buf[defs.length] = count;
      (fn as (...a: unknown[]) => void).apply(null, buf);
    }
  }

  /** Extend required component set — returns a new (cached) Query with extended include mask. */
  and<D extends ComponentDef<ComponentSchema>>(d: D): Query<[...Defs, D]>;
  and<D1 extends ComponentDef<ComponentSchema>,
      D2 extends ComponentDef<ComponentSchema>>(d1: D1, d2: D2): Query<[...Defs, D1, D2]>;
  and<D1 extends ComponentDef<ComponentSchema>,
      D2 extends ComponentDef<ComponentSchema>,
      D3 extends ComponentDef<ComponentSchema>>(d1: D1, d2: D2, d3: D3): Query<[...Defs, D1, D2, D3]>;
  and<D1 extends ComponentDef<ComponentSchema>,
      D2 extends ComponentDef<ComponentSchema>,
      D3 extends ComponentDef<ComponentSchema>,
      D4 extends ComponentDef<ComponentSchema>>(d1: D1, d2: D2, d3: D3, d4: D4): Query<[...Defs, D1, D2, D3, D4]>;
  and(...comps: ComponentDef<ComponentSchema>[]): Query<any>;
  and(...comps: ComponentDef<ComponentSchema>[]): Query<any> {
    const new_include = this._include.copy();
    const new_defs = this._defs.slice() as ComponentDef<ComponentSchema>[];
    for (let i = 0; i < comps.length; i++) {
      if (!new_include.has(comps[i] as number)) {
        new_include.set(comps[i] as number);
        new_defs.push(comps[i]);
      }
    }
    return this._ctx._resolve_query(new_include, this._exclude, this._any_of, new_defs);
  }

  /** Exclude archetypes that have any of these components. Returns same typed Query. */
  not(...comps: ComponentDef<ComponentSchema>[]): Query<Defs> {
    const new_exclude = this._exclude ? this._exclude.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_exclude.set(comps[i] as number);
    return this._ctx._resolve_query(
      this._include, new_exclude, this._any_of, this._defs
    ) as Query<Defs>;
  }

  /** Require archetypes that have at least one of these components. Returns same typed Query. */
  or(...comps: ComponentDef<ComponentSchema>[]): Query<Defs> {
    const new_any_of = this._any_of ? this._any_of.copy() : new BitSet();
    for (let i = 0; i < comps.length; i++) new_any_of.set(comps[i] as number);
    return this._ctx._resolve_query(
      this._include, this._exclude, new_any_of, this._defs
    ) as Query<Defs>;
  }
}

//=========================================================
// SystemContext
//=========================================================

export class SystemContext {
  private readonly store: Store;

  private cache: Map<number, QueryCacheEntry[]> = new Map();
  private scratch_mask: BitSet = new BitSet();

  constructor(store: Store) {
    this.store = store;
  }

  /** Create a new entity. Returns immediately (not deferred). */
  create_entity(): EntityID {
    return this.store.create_entity();
  }

  /**
   * Get a single field value for a component on an entity.
   * Looks up the entity's archetype and row.
   */
  get_field<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
    field: keyof S & string,
  ): number {
    const arch = this.store.get_entity_archetype(entity_id);
    const entity_index = get_entity_index(entity_id);
    const row = arch.get_row(entity_index);
    return arch.read_field(row, def as ComponentID, field);
  }

  /**
   * Set a single field value for a component on an entity.
   * Looks up the entity's archetype and row.
   */
  set_field<S extends ComponentSchema>(
    def: ComponentDef<S>,
    entity_id: EntityID,
    field: keyof S & string,
    value: number,
  ): void {
    const arch = this.store.get_entity_archetype(entity_id);
    const entity_index = get_entity_index(entity_id);
    const row = arch.get_row(entity_index);
    const col = arch.get_column(def, field);
    col[row] = value;
  }

  /**
   * Query for archetypes matching all provided component defs.
   * First call registers and returns a live Query; subsequent calls are a pure cache lookup.
   */
  query<A extends ComponentDef<ComponentSchema>>(a: A): Query<[A]>; // optimization*7
  query<A extends ComponentDef<ComponentSchema>,
        B extends ComponentDef<ComponentSchema>>(a: A, b: B): Query<[A, B]>;
  query<A extends ComponentDef<ComponentSchema>,
        B extends ComponentDef<ComponentSchema>,
        C extends ComponentDef<ComponentSchema>>(a: A, b: B, c: C): Query<[A, B, C]>;
  query<A extends ComponentDef<ComponentSchema>,
        B extends ComponentDef<ComponentSchema>,
        C extends ComponentDef<ComponentSchema>,
        D extends ComponentDef<ComponentSchema>>(a: A, b: B, c: C, d: D): Query<[A, B, C, D]>;
  query(...defs: ComponentDef<ComponentSchema>[]): Query<ComponentDef<ComponentSchema>[]>;
  query(): Query<ComponentDef<ComponentSchema>[]> {
    // optimization*6 start
    const mask = this.scratch_mask;
    mask._words.fill(0);
    for (let i = 0; i < arguments.length; i++) {
      mask.set(arguments[i] as unknown as number);
    }
    // optimization*6 end

    const defs = Array.from(arguments) as ComponentDef<ComponentSchema>[];
    return this._resolve_query(mask.copy(), null, null, defs);
  }

  /**
   * Buffer an entity for deferred destruction.
   * The entity stays alive until flush_destroyed() is called.
   */
  destroy_entity(id: EntityID): void {
    this.store.destroy_entity_deferred(id);
  }

  /**
   * Flush all deferred entity destructions.
   * Called by Schedule between phases — not intended for system code.
   */
  flush_destroyed(): void {
    this.store.flush_destroyed();
  }

  /**
   * Buffer a component addition for deferred processing.
   * The entity keeps its current archetype until flush() is called.
   */
  add_component<S extends ComponentSchema>(
    entity_id: EntityID,
    def: ComponentDef<S>,
    values: SchemaValues<S>,
  ): void {
    this.store.add_component_deferred(entity_id, def, values);
  }

  /**
   * Buffer a component removal for deferred processing.
   * The entity keeps its current archetype until flush() is called.
   */
  remove_component(
    entity_id: EntityID,
    def: ComponentDef<ComponentSchema>,
  ): void {
    this.store.remove_component_deferred(entity_id, def);
  }

  /**
   * Flush all deferred changes: structural (add/remove) first, then destructions.
   * Called by Schedule between phases — not intended for system code.
   */
  flush(): void {
    this.store.flush_structural();
    this.store.flush_destroyed();
  }

  //=========================================================
  // Internal
  //=========================================================

  /** Unified cache + register for all query variants (include / exclude / any_of). */
  _resolve_query(
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
    defs: readonly ComponentDef<ComponentSchema>[],
  ): Query<any> {
    const inc_hash = include.hash();
    const exc_hash = exclude ? exclude.hash() : 0;
    const any_hash = any_of  ? any_of.hash()  : 0;
    const key = ((inc_hash ^ Math.imul(exc_hash, 0x9e3779b9))
                             ^ Math.imul(any_hash, 0x517cc1b7)) | 0;

    const cached = this._find_cached(key, include, exclude, any_of);
    if (cached !== undefined) return cached.query;

    const result = this.store.register_query(
      include, exclude ?? undefined, any_of ?? undefined
    );
    const q = new Query(
      result, defs as ComponentDef<ComponentSchema>[], this,
      include.copy(), exclude?.copy() ?? null, any_of?.copy() ?? null,
    );
    bucket_push(this.cache, key, {
      include_mask: include.copy(),
      exclude_mask: exclude?.copy() ?? null,
      any_of_mask:  any_of?.copy()  ?? null,
      query: q,
    });
    return q;
  }

  /** Find a cache entry matching all three masks in a hash bucket. */
  private _find_cached(
    key: number,
    include: BitSet,
    exclude: BitSet | null,
    any_of: BitSet | null,
  ): QueryCacheEntry | undefined {
    const bucket = this.cache.get(key);
    if (!bucket) return undefined;
    for (let i = 0; i < bucket.length; i++) {
      const e = bucket[i];
      if (!e.include_mask.equals(include)) continue;
      const exc_ok = exclude === null
        ? e.exclude_mask === null
        : e.exclude_mask !== null && e.exclude_mask.equals(exclude);
      if (!exc_ok) continue;
      const any_ok = any_of === null
        ? e.any_of_mask === null
        : e.any_of_mask !== null && e.any_of_mask.equals(any_of);
      if (!any_ok) continue;
      return e;
    }
    return undefined;
  }
}
