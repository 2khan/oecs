# oecs Architecture (v0.3.0)

This document describes how oecs is built: the data layout that entities, components, and archetypes settle into; how queries stay correct as archetypes appear; how the scheduler and update loop drive systems; and the type primitives that underpin all of it.

The emphasis is *how*, not *how to use*. For usage, see the API docs in `docs/api/`:

- [components.md](./api/components.md), [entities.md](./api/entities.md), [queries.md](./api/queries.md)
- [events.md](./api/events.md), [resources.md](./api/resources.md), [refs.md](./api/refs.md)
- [systems.md](./api/systems.md), [schedule.md](./api/schedule.md), [change-detection.md](./api/change-detection.md)
- [type-primitives.md](./api/type-primitives.md)

Every non-trivial claim is tagged with a `file:line` reference so it can be verified against source.

## Table of contents

1. [Overview](#1-overview)
2. [Entities](#2-entities)
3. [Components](#3-components)
4. [Archetypes](#4-archetypes)
5. [The Store](#5-the-store)
6. [Queries](#6-queries)
7. [Change detection](#7-change-detection)
8. [Events](#8-events)
9. [Resources](#9-resources)
10. [Systems and the scheduler](#10-systems-and-the-scheduler)
11. [Update loop](#11-update-loop)
12. [Type primitives used internally](#12-type-primitives-used-internally)
13. [Dev mode](#13-dev-mode)
14. [Invariants](#14-invariants)

---

## 1. Overview

oecs is an archetype-based ECS. Entities are generational integer handles; components are typed-array columns grouped by archetype; queries are cached, live views over archetypes matching a component mask; systems are plain functions dispatched through phases.

The object graph is:

```
ECS  (src/ecs.ts)                — public facade
 ├── Store  (src/store.ts)       — owns all mutable data
 │     ├── entity slot allocator (generational IDs)
 │     ├── component metadata (per-ComponentID field layout)
 │     ├── archetype registry (mask -> Archetype) and transition-edge cache
 │     ├── entity_index -> (ArchetypeID, row) mapping
 │     ├── pending_add / pending_remove / pending_destroy buffers
 │     ├── EventChannel[] indexed by EventID
 │     ├── resource Map<symbol, unknown>
 │     └── registered live Query result arrays
 ├── Schedule  (src/schedule.ts) — per-phase topological sort
 └── SystemContext  (src/query.ts) — restricted ctx handed to systems
```

`ECS` is the only entry point external code talks to (`ecs.ts:96`). Systems receive a `SystemContext` instead of `ECS` (`query.ts:200`), which routes structural changes through the deferred buffers.

- **Entities** are 31-bit packed integers: a 20-bit slot index and an 11-bit generation counter (`entity.ts:27-31`).
- **Components** are branded integer IDs (`component.ts:33-34`) whose field schema `S` is carried only as a compile-time phantom (`component.ts:78-82`).
- **Archetypes** group every entity with an identical component mask into one object (`archetype.ts:75`). Fields live in Structure-of-Arrays columns backed by `GrowableTypedArray` (`archetype.ts:86`).
- **Queries** resolve include/exclude/any_of masks to a live `Archetype[]` that the Store keeps populated as new archetypes appear (`store.ts:202-214`, `store.ts:933-943`).
- **Change detection** is a tick counter per archetype-component slot (`archetype.ts:101`), stamped on every write path and compared to each system's `last_run_tick` (`query.ts:366-378`).
- **Events** are SoA channels flushed at the end of every `update()` (`event.ts:54-97`, `ecs.ts:488`).
- **Resources** are a plain `Map<symbol, unknown>` with no change tracking (`store.ts:1025`).
- **Systems** are scheduled into 7 phases and topologically sorted within each (`schedule.ts:34-42`, `schedule.ts:193-201`).

---

## 2. Entities

Source: `src/entity.ts`, allocator in `src/store.ts`.

### Packed handle

`EntityID` is a `Brand<number, "entity_id">` (`entity.ts:25`) with layout `[generation:11][index:20]`, totalling 31 bits so the sign bit is never set (`utils/constants.ts:14`). The constants pin the limits:

- `INDEX_BITS = 20`, `INDEX_MASK = 0xFFFFF`, `MAX_INDEX = 1,048,575` (`entity.ts:27-29`).
- `GENERATION_BITS = 11`, `MAX_GENERATION = 0x7FF = 2047` (`entity.ts:30-31`).

Pack/unpack are plain bit ops:

```ts
create_entity_id(i, g) -> (g << 20) | i     // entity.ts:33-44
get_entity_index(id)    -> id & 0xFFFFF     // entity.ts:46
get_entity_generation(id) -> id >> 20       // entity.ts:48
```

Because the packed value fits in 31 bits, the signed right-shift cleanly extracts the generation without unsigned coercion.

### Slot allocator and recycling

The Store manages slots with three fields (`store.ts:81-84`):

- `entity_generations: number[]` — current generation per slot.
- `entity_high_water: number` — next never-used slot index.
- `entity_free_indices: number[]` — stack of recycled slot indices.

`Store.create_entity` (`store.ts:274-296`) pops the free stack when non-empty, otherwise advances the high-water mark at `INITIAL_GENERATION` (`utils/constants.ts:13`, value `0`). The new entity's mapping is initialised to `(empty_archetype_id, UNASSIGNED)` so it lives in the empty archetype without a row.

Destruction (`store.ts:298-324` for the immediate path, `store.ts:354-391` for the deferred flush path) swap-removes the entity from its archetype, zeroes `entity_archetype[idx]` / `entity_row[idx]` to `UNASSIGNED` (`utils/constants.ts:1`, value `-1`), increments the generation with wraparound via `(gen + 1) & MAX_GENERATION`, and pushes the slot onto `entity_free_indices`.

### Liveness check

`Store.is_alive` (`store.ts:326-331`) is:

```ts
index < entity_high_water && entity_generations[index] === get_entity_generation(id)
```

That is the only liveness guarantee — the current generation at the slot must match the handle. A handle to a recycled slot fails the second clause.

### Dev-mode enforcement

In `__DEV__` builds, these guards throw `ECS_ERROR.ENTITY_NOT_ALIVE` on stale handles:

- Immediate structural ops: `add_component` / `remove_component` / `add_components` / `remove_components` / `has_component` (`store.ts:586, 649, 707, 738, 772`).
- Deferred ops: `destroy_entity_deferred` / `add_component_deferred` / `remove_component_deferred` (`store.ts:349, 415, 422`).
- Facade-level single-field access: `get_field` / `set_field` (`ecs.ts:273, 287`).
- Context-level single-field access and refs: `get_field` / `set_field` / `ref` / `ref_mut` / `destroy_entity` inherited check (`query.ts:223, 237, 251, 265`).

`create_entity_id` also dev-guards index and generation bounds and throws `EID_MAX_INDEX_OVERFLOW` / `EID_MAX_GEN_OVERFLOW` (`entity.ts:34-42`).

---

## 3. Components

Source: `src/component.ts`, registration in `src/store.ts`.

A component is a schema mapping field names to typed-array tags. Two registration forms:

- Record syntax gives per-field types (`ecs.ts:139, 146-157`).
- Array shorthand (with optional uniform tag, default `"f64"`) expands to a record (`ecs.ts:141-157`).

`TypedArrayTag` is the string union `"f32" | "f64" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32"` (`typed_arrays/typed_arrays.ts:17`). `TagToTypedArray` (`component.ts:45-54`) maps each tag to its concrete typed array class so column accessors return the right type at compile time.

### Phantom-typed ID

`ComponentDef<S>` is a branded number intersected with a phantom symbol property carrying the schema (`component.ts:78-82`):

```ts
declare const __schema: unique symbol;
type ComponentDef<S> = ComponentID & { readonly [__schema]: S };
```

The ID is allocated sequentially by `Store.register_component` (`store.ts:557-568`), which records `ComponentMeta = { field_names, field_index, field_types }` in a parallel array keyed by ComponentID (`store.ts:71-75, 89`). The phantom `S` is erased at runtime but flows through `add_component`, `get_field`, `set_field`, `arch.get_column`, and so on (see [components.md](./api/components.md)).

### Tags

A tag is a component with an empty schema. `register_tag` (`ecs.ts:159-161`) forwards to `register_component({})`. Tags participate in the archetype mask but are stored without columns: archetype construction skips any component whose `field_names.length === 0` (`store.ts:177`). A tag-only archetype has `has_columns === false` (`archetype.ts:137`) and takes a fast path in `add_entity_tag` / `remove_entity_tag` / `move_entity_from_tag` that only touches `entity_ids`.

---

## 4. Archetypes

Source: `src/archetype.ts`.

An archetype groups all entities sharing an identical component mask. Its identity is the `BitSet` in `archetype.ts:77`, where bit position *b* is set iff ComponentID *b* is part of the signature.

### Column layout

Each archetype owns a dense flat column store (`archetype.ts:86-102`):

- `_flat_columns: GrowableTypedArray<AnyTypedArray>[]` — every field's column across every component, packed contiguously.
- `_col_offset[cid]` — starting index in `_flat_columns` where component `cid`'s fields begin.
- `_field_count[cid]` — number of fields for component `cid`.
- `_field_index[cid]` — field-name -> index-within-component map.
- `_field_names[cid]` — field name tuple, used by `write_fields`.
- `_column_ids: number[]` — dense array of ComponentIDs that have columns, for iteration in `copy_shared_from`.
- `_changed_tick[cid]` — per-component last-modified tick (see [Change detection](#7-change-detection)).

`column_groups[cid]` (`archetype.ts:97`) holds a richer `{ layout, columns }` object kept alongside the flat storage specifically so `create_ref` (`ref.ts:60-91`) can key its prototype cache by column-group identity.

The constructor (`archetype.ts:103-138`) walks the supplied `ArchetypeColumnLayout[]`, allocates one `GrowableTypedArray` per field via `TypedArrayFor[tag]` (`typed_arrays/typed_arrays.ts:186-196`), writes its slot into `_flat_columns`, and records offsets. Tag components never enter this loop, so a pure-tag archetype gets `_flat_columns.length === 0` and `has_columns === false`.

Entity IDs are stored separately in a `GrowableUint32Array` (`archetype.ts:80, 111`). Valid rows are `0..length-1`.

### Swap-and-pop membership

All membership changes keep rows contiguous by swap-removing from the end:

- `add_entity` (`archetype.ts:282-291`) pushes the entity ID and one zero into every column, returns the new row index.
- `remove_entity` (`archetype.ts:298-319`) swaps the last row into the vacated one (`cols[i].swap_remove(row)` on each column) or pops if removing the last row. Returns the swapped entity's index (`get_entity_index(eids[row])`) or `NO_SWAP` so the Store can update that entity's mapping.
- `add_entity_tag` / `remove_entity_tag` (`archetype.ts:322-343`) skip the column work entirely for tag-only archetypes.

### Transitions between archetypes

Moving one entity uses a pre-computed transition map. `ArchetypeEdge` caches both directions of a single-component transition (`archetype.ts:54-61`):

```ts
interface ArchetypeEdge {
  add: ArchetypeID | null;
  remove: ArchetypeID | null;
  add_map: Int16Array | null;    // dst column idx -> src column idx, or -1 if new
  remove_map: Int16Array | null;
}
```

`build_transition_map(src, dst)` (`archetype.ts:461-490`) walks `dst._column_ids`: for each shared component it maps the destination's column slot to the corresponding source slot; for columns with no source it writes `-1`.

`move_entity_from` (`archetype.ts:351-383`) performs one pass: push the entity ID, then for each destination column `i`, push `src_cols[map[i]].buf[src_row]` if `map[i] >= 0` or `0` otherwise. It then stamps `_changed_tick[cid] = tick` for every component in the destination (`archetype.ts:371-374`) and calls `src.remove_entity(src_row)` (or the tag variant). The results are written to module-scope `_move_result: [dst_row, swapped_index]` (`archetype.ts:454`) — reused to avoid per-call allocation.

`move_entity_from_tag` (`archetype.ts:389-398`) is the column-free variant used when both source and destination are tag-only.

`bulk_move_all_from` (`archetype.ts:405-442`) moves every entity from a source archetype using `GrowableTypedArray.bulk_append` and `bulk_append_zeroes`, which delegate to `TypedArray.set()` (`typed_arrays/typed_arrays.ts:118-129`). This is the primitive behind `batch_add_component` and `batch_remove_component`.

### Mask operations

`matches(required)` (`archetype.ts:157-159`) is a single `BitSet.contains` check. `has_component(id)` (`archetype.ts:153-155`) is a bit test on the mask. Graph lookups are cached per-ComponentID in the sparse `edges` array (`archetype.ts:82`).

---

## 5. The Store

Source: `src/store.ts`.

`Store` owns every piece of mutable state. It exposes a typed API to `ECS` and `SystemContext` but is never handed out directly.

### Archetype registry

Archetypes are deduplicated by their BitSet mask. Two structures support this (`store.ts:98-104`):

- `archetypes: Archetype[]` — indexed by `ArchetypeID`.
- `archetype_map: Map<number, ArchetypeID[]>` — hash-bucketed by `BitSet.hash()`.
- `component_index: Map<ComponentID, Set<ArchetypeID>>` — inverted index used for query evaluation.

`arch_get_or_create_from_mask` (`store.ts:157-217`) hashes the mask, scans the bucket for an equal mask via `BitSet.equals` (buckets are tiny; linear scan is cheap), and on miss builds a new `Archetype` with column layouts derived from the component metadata, registers it in `archetype_map`, updates `component_index`, and checks every registered query (see below). The constructor creates the empty archetype eagerly (`store.ts:137`).

### Archetype graph edges

Per-component transitions are resolved lazily and cached. `arch_resolve_add` (`store.ts:220-230`) and `arch_resolve_remove` (`store.ts:233-243`) look up the cached `ArchetypeEdge`; on miss they create or find the target archetype and call `arch_cache_edge` (`store.ts:246-268`) which builds and stores `add_map` / `remove_map` in both directions. After the first transition, all subsequent `add X to [A,B]` operations are a sparse-array lookup plus a branchless column copy driven by the pre-built `Int16Array` map.

### Entity -> archetype/row

Two parallel arrays keyed by entity index (`store.ts:117-119`):

- `entity_archetype[index]: ArchetypeID | UNASSIGNED`.
- `entity_row[index]: number | UNASSIGNED`.

`UNASSIGNED = -1` (`utils/constants.ts:1`). Newly created entities are placed in the empty archetype with `entity_row = UNASSIGNED` (`store.ts:292-293`) — they occupy no row until a component is added. Every swap-remove inside an archetype returns the swapped entity's index so the Store can update its `entity_row` to the vacated slot (`store.ts:311-312, 378, 484, 539, 621, 673, 728, 763`).

### Deferred operation buffers

Systems must not shuffle archetype membership mid-iteration, so `SystemContext` writes land in flat parallel arrays (`store.ts:124-129`):

```ts
pending_destroy:    EntityID[]
pending_add_ids:    EntityID[]
pending_add_defs:   ComponentDef[]
pending_add_values: Record<string, number>[]
pending_remove_ids: EntityID[]
pending_remove_defs: ComponentDef[]
```

Operation `i` is `(pending_add_ids[i], pending_add_defs[i], pending_add_values[i])` — no per-op wrapper object.

### Flush model

`SystemContext.flush()` (`query.ts:301-304`) calls `flush_structural` then `flush_destroyed`. Structural changes apply first so that a component added and the entity destroyed in the same phase sees the add first.

`flush_structural` (`store.ts:427-433`) dispatches to `_flush_adds` (`store.ts:436-501`) and `_flush_removes` (`store.ts:504-547`), and finally calls `_mark_queries_dirty` (`store.ts:337-342`) if any buffer had entries. Each flush hoists entity arrays to locals and inlines the ID unpacking:

```ts
const idx = (eid as number) & INDEX_MASK;   // store.ts:453, 518, 368
const gen = (eid as number) >> INDEX_BITS;
if (idx >= hw || ent_gens[idx] !== gen) continue;
```

Stale-handle checks let two deferred ops target the same entity: the second becomes a silent no-op if the first has already destroyed the entity.

`_flush_adds` handles three cases: (1) the entity already has the component — overwrite in place; (2) the entity has no row — allocate one in the target; (3) the entity has a row in the source — call `move_entity_from` or `move_entity_from_tag`. Writes go through `arch.write_fields(row, comp_id, values, tick)` (`archetype.ts:215-230`), which stamps `_changed_tick[cid]`.

`_flush_removes` is symmetric, using `arch_resolve_remove` and `edge.remove_map`.

`flush_destroyed` (`store.ts:354-391`) swap-removes from the archetype, marks `entity_archetype / entity_row` as `UNASSIGNED`, increments the generation, and pushes the index onto the free list.

### Query registration

`registered_queries` (`store.ts:107-113`) holds each live query's filter masks, the `Archetype[]` result array (the Store pushes into this directly), and the `Query` instance for dirty-marking:

```ts
{ include_mask, exclude_mask, any_of_mask, result, query }
```

`register_query` (`store.ts:933-943`) snapshots existing matches via `get_matching_archetypes` and stores the record. `arch_get_or_create_from_mask` re-checks every registered query on new-archetype creation (`store.ts:202-214`), pushing the archetype and calling `query.mark_non_empty_dirty()` where it matches.

`update_query_ref` (`store.ts:945-953`) is how `ECS._resolve_query` wires the `Query` instance back into the registration record after the fact (`ecs.ts:352-361`).

`get_matching_archetypes` (`store.ts:869-927`) does the initial intersection: with an empty required mask, it filters all archetypes by exclude/any-of; otherwise it finds the smallest `component_index` set among the required bits and scans that.

### Event storage

Events live in a parallel `event_channels: EventChannel[]` array indexed by `EventID` (`store.ts:94-95`). `register_event` / `register_event_by_key` (`store.ts:963-1006`) allocate the channel; `emit_event` / `emit_signal` append a row; `clear_events` (`store.ts:985-990`) truncates every channel's `length` and each column's `length` to zero.

### Resource storage

`resource_key_map: Map<symbol, unknown>` (`store.ts:1025`). No change tracking, no entity linkage, no versioning — one value per key. See [Resources](#9-resources).

### Tick

`Store._tick: number` (`store.ts:131`) is the write-side tick stamped onto `_changed_tick`. It is synced from `ECS._tick` at the top of `ECS.update` (`ecs.ts:473`).

---

## 6. Queries

Source: `src/query.ts`, caching in `src/ecs.ts`, live registration in `src/store.ts`.

A `Query<Defs>` owns (`query.ts:72-96`):

- `_archetypes: Archetype[]` — the live result array owned by the Store's registered-queries record.
- `_defs: Defs` — the original component tuple for type-level use.
- `_resolver: QueryResolver` — the ECS itself, used to resolve chained queries and read `last_run_tick`.
- `_include` / `_exclude` / `_any_of: BitSet` masks — for composing new queries via `and` / `not` / `any_of`.
- `_non_empty_archetypes: Archetype[]` and `_non_empty_dirty: boolean` — the cached non-empty subset.

### Resolution and caching

Queries are cached in `ECS.query_cache: Map<number, QueryCacheEntry[]>` (`ecs.ts:114`). The cache key combines three `BitSet.hash()` values (`ecs.ts:341-345`):

```ts
key = (inc_hash
     ^ Math.imul(exc_hash, HASH_GOLDEN_RATIO)    // 0x9e3779b9
     ^ Math.imul(any_hash, HASH_SECONDARY_PRIME) // 0x517cc1b7
) | 0;
```

Buckets are walked linearly with exact `BitSet.equals` on all three masks (`ecs.ts:371-396`). On miss, `Store.register_query` returns a live `Archetype[]`; ECS wraps it in a `Query`, calls `store.update_query_ref` to finish wiring, then pushes the new cache entry (`ecs.ts:352-367`).

`ECS.query(...defs)` (`ecs.ts:314-323`) is variadic. It reuses a single `scratch_mask: BitSet` (`ecs.ts:116`) to avoid allocating on every call: zero the words, set the bits, then `mask.copy()` when actually building a cache entry.

`QueryBuilder.every(...)` (`query.ts:190-198`) is the registration-time variant used inside `register_system(fn, qb => qb.every(...))` (`ecs.ts:430-436`) — the builder allocates a fresh `BitSet` because the result is captured permanently in the system's closure.

### Non-empty subset

`for_each` (`query.ts:139-144`) iterates `_non_empty()` (`query.ts:151-163`), which lazily rebuilds `_non_empty_archetypes` from `_archetypes` filtered by `entity_count > 0`. It is invalidated by `mark_non_empty_dirty()`, called from:

- `Store._mark_queries_dirty`, invoked after `flush_structural` (`store.ts:432`), `flush_destroyed` (`store.ts:390`), and every immediate `add_component` / `remove_component` / bulk op (`store.ts:637, 689, 732, 767, 817, 845`).
- `Store.arch_get_or_create_from_mask`, when it pushes a new archetype into a matching query (`store.ts:212`).

Per-field writes never touch the dirty flag, so repeated `for_each` calls in the same frame hit the cache.

### Composition

`and`, `not`, `any_of` (`query.ts:115-137, 166-175`) each copy the relevant mask, add or clear bits, and delegate to `_resolver._resolve_query` — so chained queries also participate in the cache.

### ChangedQuery

`Query.changed(...defs)` (`query.ts:178-182`) returns a `ChangedQuery<Defs>` that wraps the base query with a list of component IDs to watch. Its `for_each` iterates the base query's `_non_empty()` and emits each archetype whose `_changed_tick[id]` is `>= last_run_tick` for any of the watched components (`query.ts:365-378`). In `__DEV__`, the constructor validates that every requested ID is in the base query's include mask (`query.ts:353-362`); otherwise it throws `ECS_ERROR.COMPONENT_NOT_REGISTERED`.

### SystemContext refs

`SystemContext.ref` / `ref_mut` (`query.ts:246-272`) resolve the entity's archetype and row through the Store, then call `create_ref(arch.column_groups[cid], row)` (`ref.ts:60-91`). Ref prototypes are cached per-column-group in a module-level `WeakMap` (`ref.ts:53`) — the prototype defines `get`/`set` accessors for every field at fixed `col_idx`, and each ref instance is `Object.create(proto)` plus a snapshot of the column `.buf` pointers and the row. `ref_mut` additionally sets `arch._changed_tick[cid] = store._tick` at creation (`query.ts:269`).

---

## 7. Change detection

Change detection threads through every layer: the world owns a tick counter, the archetype carries one stamp per component, every write path stamps it, and `ChangedQuery` filters archetypes by comparing against each system's `last_run_tick`.

### The tick

- `ECS._tick: number` (`ecs.ts:105`) starts at 0 and increments at the end of every `update()` (`ecs.ts:489`).
- `Store._tick: number` (`store.ts:131`) is synced from the ECS at the top of `update()` (`ecs.ts:473`) so stamps within a frame use one consistent value.
- `SystemContext.world_tick` (`query.ts:205-207`) reads `store._tick`.
- `SystemContext.last_run_tick: number` (`query.ts:202`) is written by the schedule immediately before each `fn(ctx, dt)` call (`schedule.ts:184-188`).

Startup runs with tick 0 — the ECS constructor initialises `_tick = 0` and `startup` calls `schedule.run_startup(this.ctx, this._tick)` before any `update()` has run (`ecs.ts:469`).

### What stamps `_changed_tick`

The archetype stores one tick per component (`archetype.ts:101`). These write paths stamp it:

- `write_fields` and `write_fields_positional` (`archetype.ts:215-247`) — used by `add_component`, `batch_add_component`, deferred flush, and `set_field`.
- `get_column_mut(def, field, tick)` (`archetype.ts:188-213`) — the sanctioned bulk-write accessor; it stamps before returning the column buffer.
- `copy_shared_from(src, src_row, dst_row, tick)` (`archetype.ts:259-276`) — stamps every component present on the destination.
- `move_entity_from` (`archetype.ts:351-383`) and `bulk_move_all_from` (`archetype.ts:405-442`) stamp every component in `_column_ids` on the destination, because archetype transitions reshape the destination's columns.
- `SystemContext.ref_mut` (`query.ts:269`) stamps on creation, not on field write.
- `SystemContext.set_field` and `ECS.set_field` (`query.ts:241`, `ecs.ts:291`) call `get_column_mut`.

Read paths do **not** stamp: `get_column` (`archetype.ts:162-185`), `read_field` (`archetype.ts:249-256`), `get_field`, and `SystemContext.ref` (`query.ts:246-257`).

### What `ChangedQuery` sees

`ChangedQuery.for_each` (`query.ts:365-378`) iterates the base query's non-empty archetype list and emits any archetype for which `arch._changed_tick[id] >= last_tick` for any watched component. On a system's first run, `last_run_tick` is still 0 (`query.ts:202`), so every non-empty matching archetype is visited.

The threshold is read fresh per `for_each` via `_ctx_last_run_tick` -> `_resolver._get_last_run_tick()` (`query.ts:184-187`, `ecs.ts:325-327`). Systems in the same phase fire `last_run_tick` as they dispatch (`schedule.ts:184-188`), so "writes earlier in this phase" are visible to observers later in the same phase.

### Granularity

Change ticks are per `(archetype, component)`. Mutating one row stamps the whole archetype's tick for that component. See [change-detection.md](./api/change-detection.md) for the consequences.

---

## 8. Events

Source: `src/event.ts`, storage in `src/store.ts`, lifecycle in `src/ecs.ts`.

An event is a typed, fire-and-forget message emitted during a frame and read during the same frame. The implementation is one `EventChannel` per event ID, stored in a parallel array on the Store (`store.ts:94-95`).

### EventChannel

`EventChannel` (`event.ts:54-97`) holds:

- `field_names: string[]`.
- `columns: number[][]` — one plain `number[]` per field; these are the column buffers.
- `reader: EventReader<F>` — a pre-built object with a mutable `length` and one property per field name whose value **is** the corresponding column array (`event.ts:67-74`).

Because each reader field is the underlying column array, `ctx.read(key).amount[i]` reads directly from storage — zero-copy per read.

`emit(values)` (`event.ts:76-83`) pushes one value per column looked up by field name and increments `reader.length`. `emit_signal()` (`event.ts:86-88`) only increments `reader.length` — signals have no columns to push into. `clear()` (`event.ts:90-96`) resets `reader.length` and every column's `length` to zero.

### Keys

`EventKey<F>` (`event.ts:105-107`) is a branded `symbol` with a phantom field tuple. `event_key(name)` and `signal_key(name)` factories (`event.ts:109-115`) create fresh symbols. Keys are declared at module scope and imported wherever needed — there is no central registry.

Registration maps a key to a freshly-allocated `EventID` (`store.ts:999-1006`): the ID indexes `event_channels`, the symbol keys `event_key_map`. Re-registering the same key throws `EVENT_ALREADY_REGISTERED`.

### Lifecycle

`ECS.update(dt)` clears every channel via `store.clear_events()` as the last step before incrementing the tick (`ecs.ts:488`). This means events live for exactly one `update()` call: every system dispatched during that call (fixed, pre, main, post) sees the same growing reader; the reader is reset before the next call.

Because Event storage is separate from the archetype graph, events have no impact on the change-detection tick.

---

## 9. Resources

Source: `src/resource.ts`, storage in `src/store.ts`.

Resources are world-scoped singleton values identified by a `ResourceKey<T>` — a `symbol` intersected with a phantom property carrying `T` (`resource.ts:22`). `resource_key<T>(name)` creates a fresh symbol (`resource.ts:24-26`).

The store is a plain `Map<symbol, unknown>` (`store.ts:1025`):

- `register_resource(key, value)` (`store.ts:1027-1032`) inserts exactly once; duplicate registration throws `RESOURCE_ALREADY_REGISTERED`.
- `get_resource(key)` (`store.ts:1034-1039`) and `set_resource(key, value)` (`store.ts:1041-1046`) both throw `RESOURCE_NOT_REGISTERED` if the key is missing.
- `has_resource(key)` (`store.ts:1048-1050`) is the single lookup that never throws.

The facade and `SystemContext` go through `unsafe_cast<T>` to recover the value type from the phantom (`ecs.ts:175-177`, `query.ts:333-335`). There is no change-tracking on resources, no per-field column, no archetype linkage. The value can be any JavaScript value — objects, typed arrays, maps, class instances.

---

## 10. Systems and the scheduler

Source: `src/system.ts`, `src/schedule.ts`, topological sort in `src/type_primitives/topological_sort/topological_sort.ts`.

A system is a `SystemConfig` (`system.ts:31-37`): an `fn: (ctx, dt) => void` plus optional `name`, `on_added(ctx)`, `on_removed()`, and `dispose()` hooks. `ECS.register_system` (`ecs.ts:413-448`) assigns a `SystemID`, freezes the config into a `SystemDescriptor`, and stores it in a `Set`.

### Phases

`SCHEDULE` is a string enum with seven values (`schedule.ts:34-42`):

- `PRE_STARTUP`, `STARTUP`, `POST_STARTUP` — the startup window, run once by `ECS.startup()` (`ecs.ts:465-470`).
- `FIXED_UPDATE` — accumulator-driven fixed-timestep phase (see below).
- `PRE_UPDATE`, `UPDATE`, `POST_UPDATE` — the per-frame window, run by `ECS.update(dt)`.

Phase ordering is hard-coded by `run_startup`, `run_update`, `run_fixed_update` (`schedule.ts:138-152`). Startup and update labels are iterated in the listed order.

### SystemNode and ordering

Each scheduled system becomes a `SystemNode` (`schedule.ts:58-63`):

```ts
{
  descriptor: SystemDescriptor,
  insertion_order: number,
  before: Set<SystemDescriptor>,
  after:  Set<SystemDescriptor>,
}
```

`insertion_order` is a monotonically increasing counter shared across all phases (`schedule.ts:70, 98`). `add_systems` dev-checks for duplicate scheduling and throws `DUPLICATE_SYSTEM` (`schedule.ts:87-94`). Adding or removing a system invalidates its phase's cached order (`schedule.ts:107, 135`).

### Topological sort

`sort_systems` (`schedule.ts:209-261`) constructs a dependency edge map:

- For each `before: [X]` on a node, add edge `node -> X`.
- For each `after: [X]` on a node, add edge `X -> node`.

Edges pointing at nodes in a different phase are filtered out via `node_set` membership. Insertion order is looked up per descriptor and passed in as the tiebreaker comparator. The sort delegates to the shared primitive `topological_sort` (`type_primitives/topological_sort/topological_sort.ts:27-94`).

`topological_sort` is Kahn's algorithm with a `BinaryHeap<T>` as the ready queue (`topological_sort.ts:54`). The comparator is honoured per-`pop`: when multiple nodes are simultaneously unblocked, the heap returns the one with the lowest insertion order first. If the result length does not equal the node count, the remaining in-degrees indicate a cycle and it throws `globalThis.TypeError` (`topological_sort.ts:88-91`). The schedule catches this and re-throws as `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` with the phase label and pending names (`schedule.ts:250-260`).

### Per-system tick bookkeeping

`system_last_run: Map<SystemDescriptor, number>` (`schedule.ts:69`) is updated inside `run_label` (`schedule.ts:182-191`):

```ts
for (let i = 0; i < sorted.length; i++) {
  this.system_last_run.set(sorted[i], tick);
  ctx.last_run_tick = tick;
  sorted[i].fn(ctx, delta_time);
}
ctx.flush();
```

`ctx.last_run_tick` is overwritten before each `fn` call, so the value read inside `fn` is the current world tick — which is what `ChangedQuery` keys on. After the last system in the phase completes, `ctx.flush()` applies the deferred structural changes and destructions so the next phase sees a consistent world.

---

## 11. Update loop

Source: `src/ecs.ts`.

`ECS.update(dt)` (`ecs.ts:472-490`) is exactly:

```ts
1. store._tick = this._tick;                                   // ecs.ts:473

2. if (schedule.has_fixed_systems()) {                         // ecs.ts:475
     accumulator += dt;                                        // ecs.ts:476
     accumulator = min(accumulator, max_fixed_steps * fixed_timestep);  // ecs.ts:477-480
     while (accumulator >= fixed_timestep) {
       schedule.run_fixed_update(ctx, fixed_timestep, _tick);  // ecs.ts:482
       accumulator -= fixed_timestep;                          // ecs.ts:483
     }
   }

3. schedule.run_update(ctx, dt, _tick);                        // ecs.ts:487
     // runs PRE_UPDATE -> UPDATE -> POST_UPDATE in order (schedule.ts:144-148)
     // flushes ctx between phases and after the last phase

4. store.clear_events();                                       // ecs.ts:488

5. _tick++;                                                    // ecs.ts:489
```

Observations:

- **The fixed-update loop is skipped entirely** when no systems are registered in `FIXED_UPDATE` (`ecs.ts:475`, `schedule.ts:154-157`). The accumulator does not advance when unused.
- **Spiral-of-death clamp**: the accumulator is capped at `max_fixed_steps * fixed_timestep` before draining (`ecs.ts:477-480`). Defaults are `DEFAULT_FIXED_TIMESTEP = 1/60` and `DEFAULT_MAX_FIXED_STEPS = 4` (`utils/constants.ts:17-18`).
- **Fixed steps use the same world tick**. `run_fixed_update` passes `this._tick` on every call inside the drain loop (`ecs.ts:482`), so multiple fixed steps in one frame share one tick value. Events emitted during a fixed step are not cleared until the end of `update()`.
- **`fixed_alpha`** (`ecs.ts:134-136`) exposes `accumulator / fixed_timestep` so renderers can interpolate between fixed-step states.
- **Events live for one full `update()`** — emitted during any phase within this call, visible to every subsequent phase, cleared at step 4.
- **Tick increments last**. This means a system in `POST_UPDATE` reading `ctx.world_tick` sees the same value as one in `PRE_UPDATE` or `FIXED_UPDATE` within the same call.

`ECS.startup()` (`ecs.ts:465-470`) is simpler: it calls every descriptor's `on_added(ctx)`, then `schedule.run_startup(ctx, _tick)` which runs `PRE_STARTUP -> STARTUP -> POST_STARTUP` with `STARTUP_DELTA_TIME = 0` (`utils/constants.ts:21`, `schedule.ts:139-141`). `_tick` is 0 during startup and still 0 on the first `update()` call's systems — it becomes 1 only after the first `update()` completes.

---

## 12. Type primitives used internally

Source: `src/type_primitives/`.

The primitives are also exported publicly (see [type-primitives.md](./api/type-primitives.md)); here we describe how each one is used inside the ECS.

### BitSet

`number[]`-backed bit set with auto-grow (`type_primitives/bitset/bitset.ts`). Each 32-bit word holds 32 bits. Initial capacity is 4 words (128 bits) (`bitset.ts:27`); `grow()` doubles (`bitset.ts:151-157`).

Used for:

- **Archetype masks** — the identity of each archetype (`archetype.ts:77`).
- **Query include/exclude/any_of filters** (`query.ts:76-78`, `ecs.ts:114-116`).
- **Component index bit iteration** — `get_matching_archetypes` iterates required bits via `word & (-word >>> 0)` lowest-bit extraction and `Math.clz32` for bit position (`store.ts:894-911`), the same trick used in `BitSet.for_each` (`bitset.ts:132-149`).

Hash (`bitset.ts:118-129`) is FNV-1a over non-trailing-zero words so two BitSets with the same bits but different backing-array lengths hash and compare equally.

### SparseSet / SparseMap

O(1) integer-keyed containers with cache-friendly dense iteration (`type_primitives/sparse_set/sparse_set.ts`, `type_primitives/sparse_map/sparse_map.ts`). Membership is `dense[sparse[key]] === key`, so stale sparse entries are harmless.

These are exported by the package but the current ECS source does not use them directly — the archetype-lookup path uses hash-bucketed `Map<number, ArchetypeID[]>` (`store.ts:100`); entity->archetype/row uses plain parallel arrays (`store.ts:117-119`); `component_index` uses `Map<ComponentID, Set<ArchetypeID>>` (`store.ts:104`). The sparse-set pattern *is* present in `Archetype._col_offset` / `_field_count` / `_field_index` (sparse arrays indexed by ComponentID, dense iteration via `_column_ids`) (`archetype.ts:86-99`).

### GrowableTypedArray

`TypedArray` wrapped with a separate logical length and a doubling backing buffer (`type_primitives/typed_arrays/typed_arrays.ts`). `push` is amortised O(1); `bulk_append` uses `TypedArray.set()` for fast batch copies (`typed_arrays.ts:118-122`).

Named subclasses exist for every tag in `TypedArrayTag` (`typed_arrays.ts:138-184`), and `TypedArrayFor` maps tag strings to classes (`typed_arrays.ts:186-195`). Default capacity is `DEFAULT_INITIAL_CAPACITY = 16` with `GROWTH_FACTOR = 2`.

Used for:

- Every archetype column (`archetype.ts:86, 118-129`).
- Archetype `entity_ids` (`archetype.ts:80-111`, `GrowableUint32Array`).
- Bulk moves (`bulk_append`, `bulk_append_zeroes` — `archetype.ts:414-423`).

Note on the `buf` accessor (`typed_arrays.ts:80-82`): the raw backing buffer reference is invalidated by any `push`/`ensure_capacity`/`bulk_append` that triggers a grow. Inside system inner loops, read `arch.get_column(...)` or `arch.get_column_mut(...)` once per archetype, not once per row.

### BinaryHeap

Array-backed heap with a user-supplied comparator (`type_primitives/binary_heap/binary_heap.ts`). When `compare(a, b) < 0`, `a` has higher priority. Used inside `topological_sort` as the ready queue (`topological_sort.ts:54`): during scheduling, the heap's comparator is `insertion_order(a) - insertion_order(b)` so the lowest-registered unblocked system pops first.

### Brand, casts, and assertions

`Brand<T, Name>` (`type_primitives/brand.ts`) is the phantom-symbol nominal-typing helper used for `EntityID`, `ComponentID`, `ArchetypeID`, `SystemID`, `EventID`. `validate_and_cast` mints branded values with a dev-mode validator; `unsafe_cast` is a pure type cast used in places where the caller asserts validity (`type_primitives/assertions.ts:42-58`). All assertion helpers are gated by `__DEV__` (`assertions.ts:22, 34, 47`).

---

## 13. Dev mode

`__DEV__` is a compile-time constant replaced at build time. Every `if (__DEV__) { ... }` branch is dead code in production and tree-shaken by the bundler.

### What gets checked

- **Entity liveness**: every `SystemContext` / `ECS` entry point that reads or mutates a specific entity throws `ECS_ERROR.ENTITY_NOT_ALIVE` if `store.is_alive(id)` fails. Examples: `ECS.get_field` / `set_field` (`ecs.ts:273, 287`), `SystemContext.get_field` / `set_field` / `ref` / `ref_mut` (`query.ts:223, 237, 251, 265`), every immediate and deferred structural op (`store.ts:301, 349, 415, 422, 586, 649, 707, 738, 772`).
- **Generation overflow**: `destroy_entity` / `flush_destroyed` guard `generation >= MAX_GENERATION` and throw `EID_MAX_GEN_OVERFLOW` (`store.ts:320, 383`).
- **EntityID bounds**: `create_entity_id` guards `index` and `generation` ranges (`entity.ts:34-42`).
- **Archetype bounds**: `Store.arch_get` throws `ARCHETYPE_NOT_FOUND` on an out-of-range ID (`store.ts:144-151`).
- **Column validity**: `Archetype.get_column` / `get_column_mut` throw `COMPONENT_NOT_REGISTERED` if the component is not present in the archetype or the field name is invalid (`archetype.ts:167-183, 194-211`).
- **ChangedQuery inputs**: the constructor throws `COMPONENT_NOT_REGISTERED` if any watched component is not in the base query's include mask (`query.ts:353-362`).
- **Duplicate system scheduling**: `Schedule.add_systems` throws `DUPLICATE_SYSTEM` (`schedule.ts:87-94`).
- **Branded-type validation**: `validate_and_cast` runs its validator in dev (`assertions.ts:42-54`); used by `as_component_id`, `as_archetype_id`, `as_system_id`, `as_event_id`.
- **Assertions**: `assert`, `assert_non_null` are dev-only (`assertions.ts:17-40`).

### What is always active

`topological_sort`'s cycle detection is not dev-gated (`topological_sort.ts:83-91`) — the algorithm needs the check to produce a correct result, so it runs in production too. The schedule's re-throw wraps this into `CIRCULAR_SYSTEM_DEPENDENCY` (`schedule.ts:250-260`).

`register_event_by_key` / `register_resource` checks for duplicate keys run always (`store.ts:1000, 1028`) — those guard against silently overwriting state.

### When `__DEV__` is active

During Vite dev builds, tests, and any build that leaves `__DEV__` as truthy, every guard above runs. For production library builds, `__DEV__` is replaced by `process.env.NODE_ENV !== "production"`, letting the consumer's bundler evaluate it at their build time — a consumer's production bundle strips all dev checks, a consumer's dev bundle keeps them.

---

## 14. Invariants

A short list of cross-cutting invariants worth knowing:

1. **Archetype membership changes only at flush boundaries during system execution.** Inside `query.for_each`, the entity's `(archetype_id, row)` pair is stable because all structural ops routed through `SystemContext` go to the deferred buffers (`query.ts:275-298`). Immediate ops on `ECS` bypass this and must not be called from inside a system.

2. **`_archetypes` is append-only, never reordered.** The Store pushes new matching archetypes into each registered query's result array (`store.ts:211`) but never removes entries. Empty archetypes remain in the list; `_non_empty()` filters them.

3. **`entity_ids[row]` is always consistent with `entity_archetype` / `entity_row`.** Every swap-remove path returns the swapped entity's index so the Store can update the map before returning control (`store.ts:311-312, 378, 484, 539, 621, 673, 728, 763`). A mismatch would cause silent data corruption; it is an invariant maintained by every write path in `Store` and `Archetype`.

4. **Entity handles to destroyed slots fail `is_alive` after the flush.** Until `flush_destroyed` runs, the entity is still fully indexed and queries still see it. After flush, the generation has incremented and any stale handle fails the compare (`store.ts:326-331, 383-384`).

5. **Registered queries never go stale.** `arch_get_or_create_from_mask` re-checks every registered query on creation and pushes into matching result arrays before returning the new archetype (`store.ts:202-214`). No background scan is ever needed.

6. **Per-field writes do not invalidate the non-empty archetype cache.** Only structural operations (entity add/remove/move, new archetype created) call `mark_non_empty_dirty` (`store.ts:337-342, 212`). Repeated `for_each` calls within a single frame hit the cache.

7. **Change-detection granularity is per `(archetype, component)`.** Writing one row stamps the whole archetype for that component (`archetype.ts:101, 202, 224, 242, 269, 371-374, 428-430`). `ChangedQuery` yields whole archetypes; per-row filtering is the caller's responsibility.

8. **`ctx.last_run_tick` is set per-dispatch, not per-system.** A single `SystemDescriptor` scheduled in two phases is still two distinct run slots in `system_last_run`, but `ctx.last_run_tick` is overwritten immediately before each dispatch (`schedule.ts:184-188`). Read it at the top of your system body, do not cache across calls.

9. **All deferred ops are re-validated against the entity's generation at flush time.** Flush loops inline the generation check so an entity destroyed by an earlier deferred op cannot crash a later one (`store.ts:371, 455, 520`) — the later op becomes a no-op.

10. **Archetype transitions stamp the destination, not the source.** `move_entity_from` and `bulk_move_all_from` stamp `_changed_tick` for every component in the destination (`archetype.ts:371-374, 428-430`). This means adding or removing any component lights up change-detection for every component on the new archetype, including ones the user did not touch.

11. **Events outlive one `update()` call and no longer.** Emission appends; clear happens once per `ECS.update()` at the end, before the tick increments (`ecs.ts:488-489`). Nothing else clears events.

12. **Resources have no change tracking.** `set_resource` writes to a `Map<symbol, unknown>`; there is no tick, no version, no archetype link. Systems that need resource change detection must track it explicitly in the value.
