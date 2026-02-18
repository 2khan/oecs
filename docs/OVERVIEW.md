# OECS — System Overview

A guided tour from first principles to implementation detail.
Each section opens with a plain-English summary, then digs into how the code actually works.
Cross-references to optimization rationale are in `DESIGN.md` as `[opt:N]`.

---

## Table of contents

1. [What is an ECS?](#1-what-is-an-ecs)
2. [Entities](#2-entities)
3. [Components](#3-components)
4. [Archetypes](#4-archetypes)
5. [BitSet — the component fingerprint](#5-bitset--the-component-fingerprint)
6. [ArchetypeRegistry — bookkeeping and transitions](#6-archetyperegistry--bookkeeping-and-transitions)
7. [Store — the single source of truth](#7-store--the-single-source-of-truth)
8. [Queries](#8-queries)
9. [Systems and Scheduling](#9-systems-and-scheduling)
10. [End-to-end data flow](#10-end-to-end-data-flow)

---

## 1. What is an ECS?

**Plain English:** Most game engines model things as objects — a `Player` object knows its position, its health, and how to move. This feels natural but is slow at scale: thousands of players means thousands of scattered objects in memory, and every frame the CPU has to jump around to find the data it needs.

An Entity Component System flips this around:

- **Entity** — a meaningless ID number. It represents "a thing" but knows nothing about itself.
- **Component** — a plain data bag (position, health, velocity). No methods, just numbers.
- **System** — a function that runs every frame and operates on *all* entities that have a particular set of components.

The gain: all position data lives in one contiguous array, all velocity data in another. A movement system reads through them linearly. The CPU's cache prefetcher loves this.

---

## 2. Entities

**Plain English:** An entity is a ticket stub. The number on the stub tells you which drawer to open to find that entity's data. When an entity is destroyed, the drawer gets recycled — but the old stub becomes invalid so nobody can use a stale reference accidentally.

### ID layout `[opt:1]`

Every entity is a single 32-bit integer with two packed fields:

```
Bits:  [31 ........... 20][19 ........... 0]
        generation (12)     index (20)
```

| Field | Bits | Max value | Purpose |
|-------|------|-----------|---------|
| index | 20 | ~1 million | Which slot in the data arrays |
| generation | 12 | 4,095 | How many times this slot has been reused |

```typescript
// entity.ts
export const create_entity_id = (index: number, generation: number): EntityID =>
  unsafe_cast<EntityID>(((generation << INDEX_BITS) | index) >>> 0);
```

The `>>> 0` coercion is critical — it forces the result to an **unsigned** 32-bit integer so that high-bit generation values are not misinterpreted as negative by JS bitwise operators.

### Why generations?

Say entity with index 5 is created, used, then destroyed. The next entity allocated to slot 5 gets `generation + 1`. Any old code that kept a reference to the first entity (generation 0) runs `is_alive(old_id)` — the stored generation doesn't match, so it correctly returns `false`. This is the ECS equivalent of a dangling pointer check, at zero memory cost.

### EntityRegistry

`EntityRegistry` maintains:
- `indices: Uint16Array` — the generation for each slot
- A free-list of recycled slot indices

`create_entity()` pops from the free-list (or extends it), returns the packed ID.
`destroy(id)` bumps the generation in the slot and pushes the index back onto the free-list.

---

## 3. Components

**Plain English:** A component is a description of what data an entity carries. You define it as a schema — field names and their numeric type (`"f32"`, `"u8"`, etc.). Actual values are stored in flat typed arrays in memory, not as JS objects. This keeps data compact and avoids garbage collection pressure.

### Defining a component

```typescript
const Position = { x: "f32", y: "f32" } as const;
const Pos = store.register_component(Position);
// Pos is a ComponentDef<{ x: "f32", y: "f32" }>
```

### ComponentDef — phantom typing

`ComponentDef<S>` is a **phantom type**: at runtime it's just a number (the component's unique ID assigned by the registry), but at compile time it carries the full schema `S`. This means:

```typescript
arch.get_column(Pos, "x")   // → Float32Array   ✓
arch.get_column(Pos, "z")   // TypeScript error  ✓
```

No runtime casts, no `as any`. The type information is erased in the output JS but enforced at development time.

### TypeTag → TypedArray mapping

| TypeTag | Backing array |
|---------|--------------|
| `"f32"` | `Float32Array` |
| `"f64"` | `Float64Array` |
| `"u8"`  | `Uint8Array` |
| `"u16"` | `Uint16Array` |
| `"u32"` | `Uint32Array` |
| `"i8"`  | `Int8Array` |
| `"i16"` | `Int16Array` |
| `"i32"` | `Int32Array` |

The `TYPED_ARRAY_MAP` in `type_primitives` is the single lookup table. Every archetype column is allocated using this map.

### ComponentRegistry

Tracks per component: field names, field TypeTags, and a field-name→index map for O(1) column lookup. Returns a `ComponentDef<S>` handle on registration.

### Tag components

A component with an empty schema (`{}`) is a **tag** — it carries no data, only presence. It contributes a bit to the archetype mask and enables filtering (`not(Static)`) without any array storage.

---

## 4. Archetypes

**Plain English:** An archetype is a table. Every entity that has the exact same set of components sits in the same table row. All position data for those entities is in one array, all velocity data in another — tightly packed, row-aligned. Iterating 10,000 entities with [Pos, Vel] is a single forward pass through two arrays. No object lookups, no pointer chasing.

### The table structure

```
Archetype [Pos, Vel]
  entity_ids:   [ e1,  e2,  e3, ... ]   ← dense, Uint32Array
  Pos.x:        [ 1.0, 5.0, 3.0, ... ]  ← Float32Array
  Pos.y:        [ 2.0, 6.0, 4.0, ... ]  ← Float32Array
  Vel.vx:       [ 0.1, 0.0, 0.2, ... ]  ← Float32Array
  Vel.vy:       [ 0.0, 0.3, 0.0, ... ]  ← Float32Array
```

Row `i` holds all data for the `i`-th entity in this archetype. All arrays grow together.

### Sparse-set membership `[opt:2]`

Two arrays manage entity membership:

- **`entity_ids: Uint32Array`** (dense) — the entity IDs, packed into rows 0..N-1.
- **`index_to_row: Int32Array`** (sparse) — maps `entity_index → row`. The sentinel `-1` marks empty slots.

This gives O(1) "is entity in this archetype?" and O(1) "which row is entity X in?".

### Swap-and-pop removal

When entity at row `r` is removed, the entity at the *last* row is moved into row `r`. No gaps, no shifting — O(1) regardless of table size. All component columns are swapped in the same operation.

### Column growth `[opt:9]`

All arrays start at capacity 16 and double when full. All component columns and `entity_ids` grow together so they always stay the same length.

### Archetype graph edges `[opt:3]`

When an entity gains a component, it must move to a different archetype (the one with all its current components plus the new one). Rather than recomputing this every time, archetypes cache transitions:

```typescript
// Archetype [Pos] caches:
//   "add Vel" → ArchetypeID of [Pos, Vel]
//   "remove Pos" → ArchetypeID of []
edges: Map<ComponentID, { add: ArchetypeID | null, remove: ArchetypeID | null }>
```

First transition: O(mask arithmetic + hash lookup). Every subsequent transition for the same component: O(1) Map lookup.

### Zero-copy transitions

The key design insight: component data is indexed by **entity index**, not by archetype row. The `ComponentRegistry` stores everything in flat arrays keyed by the entity's slot index. Moving an entity between archetypes only updates the membership arrays — no component values are copied across. (The archetype columns hold a *dense* view for iteration; these are written when the entity first gets each component and updated on transitions via `copy_shared_from`.)

---

## 5. BitSet — the component fingerprint

**Plain English:** Every archetype has a fingerprint — a sequence of bits, one per component type. Bit 3 is set? This archetype has component 3. Comparing two fingerprints tells you instantly whether an archetype matches a query, without looking at any lists.

### Implementation

`BitSet` is backed by a `Uint32Array`, packing 32 component bits per word. Default capacity is 4 words (128 components); it auto-grows as needed.

```typescript
// "Does archetype have all required components?"
contains(other: BitSet): boolean  // superset check: (this & other) === other

// "Does archetype have any excluded/or components?"
overlaps(other: BitSet): boolean  // intersection check: (this & other) !== 0

// "Are two masks identical?"
equals(other: BitSet): boolean

// FNV-1a hash (used as Map key)
hash(): number
```

### Frozen masks `[opt:5]`

After an archetype is created, its mask is frozen with `Object.freeze`. This tells V8 the object shape is permanent, allowing the JIT to treat it as a stable monomorphic hidden class throughout its lifetime. Mutable same-shaped objects can cause V8 to de-optimise to slow megamorphic IC sites.

---

## 6. ArchetypeRegistry — bookkeeping and transitions

**Plain English:** The archetype registry is the librarian. It keeps a catalogue of every archetype that exists, makes sure no two archetypes have the same component set, and maintains an index so queries can find matching archetypes fast.

### Deduplication

Archetypes are stored in a `Map<hash, ArchetypeID[]>`. Creating an archetype with mask `{Pos, Vel}`:
1. Compute `mask.hash()` — the FNV-1a hash of the BitSet words.
2. Look up the hash bucket. If any stored archetype has `.mask.equals(new_mask)`, return its ID.
3. Otherwise allocate a new `Archetype`, store it, update the component index.

Hash collisions are resolved by full `equals()` comparison within the bucket.

### Component index

```typescript
component_index: Map<ComponentID, Set<ArchetypeID>>
```

Every archetype is registered in the sets of all its components. This powers the query matching optimization.

### Query matching `[opt:4]`

`get_matching(include, exclude?, any_of?)` uses the component index to avoid scanning all archetypes:

1. Find the component in the include mask with the **fewest** archetypes in the index.
2. Iterate only those archetypes (smallest set).
3. For each, check: `arch.mask.contains(include) && !overlaps(exclude) && overlaps(any_of)`.

The worst case is the rarest component's archetype count, not the total archetype count.

The bit-scan over the query mask is inlined (not delegated to `BitSet.for_each`) to avoid a closure allocation on this hot path.

### Push-based query updates

Registered queries are stored as:

```typescript
{ include_mask, exclude_mask, any_of_mask, result: Archetype[] }
```

When a new archetype is created, the registry loops through every registered query and pushes the archetype into `result` if it matches. The `result` array is the **same array reference** held by the `Query` object — so all live queries auto-update with zero re-registration.

---

## 7. Store — the single source of truth

**Plain English:** The Store is the central hub. It owns every registry and is the only code that knows "entity 5 is currently in archetype 3". All entity and component operations route through it.

### What it owns

| Field | Type | Purpose |
|-------|------|---------|
| `entities` | `EntityRegistry` | ID allocation, alive checks |
| `components` | `ComponentRegistry` | Schema storage, TypedArray info |
| `archetype_registry` | `ArchetypeRegistry` | Archetypes, queries, transitions |
| `entity_archetype` | `Int32Array` | `entity_index → ArchetypeID`, O(1) lookup |

`entity_archetype` is a flat `Int32Array` rather than a `Map` — indexed directly by entity slot index. Reads and writes are a single array access.

### add_component flow

```
1. Assert entity alive
2. current_arch = archetypes[entity_archetype[entity_index]]
3. If already has component → write fields in-place, return
4. target_arch_id = archetype_registry.resolve_add(current_arch_id, component_id)
   → graph edge cache hit → O(1)
   → cache miss → build new mask, get_or_create, cache edge
5. dst_row = target_arch.add_entity(entity_id, entity_index)
6. target_arch.copy_shared_from(current_arch, src_row, dst_row)   ← copies existing component data
7. target_arch.write_fields(dst_row, component_id, values)         ← writes new component data
8. current_arch.remove_entity(entity_index)                        ← swap-and-pop
9. entity_archetype[entity_index] = target_arch_id
```

### Deferred structural changes

Systems run inside `ctx.flush()` boundaries. Calling `ctx.add_component()` or `ctx.remove_component()` during a system does **not** immediately mutate archetype membership — it pushes to `pending_add` / `pending_remove` buffers. After every phase, `flush_structural()` applies them in order (adds before removes), then `flush_destroyed()` runs entity destructions.

This guarantees systems in the same phase see a consistent snapshot of the world, and prevents iterator invalidation mid-`each()`.

---

## 8. Queries

**Plain English:** A query is a standing subscription: "give me all archetypes matching these filters, now and in the future". You build it with a fluent chain, call `.each()` to iterate, and never pay more than a hash lookup on repeated calls.

### The builder API

```typescript
ctx.query(Pos)           // all archetypes with Pos
  .and(Vel)              // + must have Vel
  .not(Static)           // must NOT have Static
  .or(Damaged, Burning)  // must have at least one of these
  .each((pos, vel, n) => {
    for (let i = 0; i < n; i++) {
      pos.x[i] += vel.vx[i] * dt;
    }
  });
```

### Three-mask semantics

| Mask | Built by | Archetype passes when |
|------|----------|-----------------------|
| `include` | `query()` / `.and()` | `arch.mask.contains(include)` |
| `exclude` | `.not()` | `!arch.mask.overlaps(exclude)` |
| `any_of` | `.or()` | `arch.mask.overlaps(any_of)` |

### Caching

Every `Query` is cached by a combined hash of all three masks:

```typescript
const key = ((inc_hash ^ Math.imul(exc_hash, 0x9e3779b9))
                         ^ Math.imul(any_hash, 0x517cc1b7)) | 0;
```

Cache hit → same `Query` reference returned, O(1), zero allocation.
Cache miss → `store.register_query()` called once, live array registered, `Query` stored.

`.and()` and `.or()` chain by building new masks from the current ones and calling `_resolve_query()`. Order is irrelevant — same component set produces the same BitSet hash.

### `SystemContext.query()` scratch mask `[opt:6]`

`query()` reuses a single `scratch_mask: BitSet` rather than allocating a new one each call. It fills the scratch mask in-place, calls `mask.copy()` before passing it downstream, then the scratch is ready for the next call. The `arguments` object is used instead of rest parameters (`...defs`) to avoid materialising a temporary `Array` on every call.

### `Query.each()` — the hot path

```typescript
each(fn: EachFn<Defs>): void {
  for (let ai = 0; ai < archs.length; ai++) {
    const arch = archs[ai];
    const count = arch.entity_count;
    if (count === 0) continue;
    // fill pre-allocated args buffer with typed column records + count
    (fn as (...a: unknown[]) => void).apply(null, buf);
  }
}
```

`fn` is called **once per archetype**, not once per entity. Inside `fn`, the user's loop runs over raw TypedArray slices — no boxing, no GC, no per-entity dispatch. The args buffer (`_args_buf`) is pre-allocated at `Query` construction time and reused on every `each()` call.

---

## 9. Systems and Scheduling

**Plain English:** A system is just a function. You register it, tell the scheduler which phase it belongs to (and optionally what it must run before or after), and the engine calls it every frame. Between systems in a phase, deferred changes are buffered. Between phases, they flush.

### SystemFn

```typescript
type SystemFn = (ctx: SystemContext, delta_time: number) => void;
```

`SystemContext` is the only interface available to a system. It wraps the Store and exposes:
- `query()` — the entry point for all data reads
- `add_component()` / `remove_component()` — deferred structural changes
- `destroy_entity()` — deferred destruction
- `get_field()` / `set_field()` — single-entity field access

### Lifecycle hooks

When registering a system (`store.register_system(config)`), you can provide:

| Hook | When called |
|------|-------------|
| `on_added(store)` | Immediately after registration — use for pre-computation |
| `on_removed()` | When the system is removed from the registry |
| `dispose()` | On world teardown |

### Phases

```
PRE_STARTUP → STARTUP → POST_STARTUP    (once on world.start())
PRE_UPDATE  → UPDATE  → POST_UPDATE     (every world.update(dt))
```

Each phase runs all its systems in topological order, then calls `ctx.flush()`.

### Ordering constraints `[opt:8]`

Systems within a phase can declare ordering:

```typescript
schedule.add_systems(SCHEDULE.UPDATE,
  { system: PhysicsSystem, ordering: { before: [RenderSystem] } },
  RenderSystem,
);
```

The `Schedule` resolves these with **Kahn's algorithm**:
1. Build a directed acyclic graph from `before`/`after` constraints.
2. Process nodes with in-degree 0 (no unsatisfied dependencies) using a min-heap keyed by insertion order — deterministic tiebreaking.
3. If any nodes remain after the sort, a cycle exists and an error is thrown immediately at sort time (not at runtime during a frame).

Sorted order is cached — re-sort only happens when the system list changes.

---

## 10. End-to-end data flow

### Startup

```
world.start()
  └── schedule.run_startup(ctx)
        ├── PRE_STARTUP:  systems run, ctx.flush()
        ├── STARTUP:      systems run, ctx.flush()
        └── POST_STARTUP: systems run, ctx.flush()
```

### Frame update

```
world.update(dt)
  └── schedule.run_update(ctx, dt)
        ├── PRE_UPDATE:  systems run, ctx.flush()
        ├── UPDATE:      systems run, ctx.flush()
        └── POST_UPDATE: systems run, ctx.flush()
```

### Inside a system

```
movementSystem(ctx, dt):
  ctx.query(Pos).and(Vel).not(Static)
    .each((pos, vel, n) => {
      for (let i = 0; i < n; i++) {
        pos.x[i] += vel.vx[i] * dt;   // Float32Array direct write
        pos.y[i] += vel.vy[i] * dt;
      }
    });
```

### add_component across a frame boundary

```
Frame N, system A:
  ctx.add_component(e, Vel, {vx:1, vy:0})
    → pushed to store.pending_add[]

End of phase (ctx.flush()):
  store.flush_structural()
    └── store.add_component(e, Vel, {vx:1, vy:0})
          ├── resolve_add: [Pos] + Vel → [Pos, Vel]  (graph edge, O(1))
          ├── [Pos, Vel].add_entity(e)               (new row)
          ├── copy_shared_from([Pos], src_row)       (copy Pos data)
          ├── write_fields(dst_row, Vel, {vx:1})     (write Vel data)
          ├── [Pos].remove_entity(e_index)           (swap-and-pop)
          └── registered_queries updated              (push [Pos,Vel] arch to matching live arrays)

Frame N+1, system B:
  ctx.query(Pos, Vel)   // cache hit, same Query reference, now length > 0
```

---

## File map

```
src/
  world.ts                    ← public API facade
  store/store.ts              ← orchestrator, owns all registries
  entity/
    entity.ts                 ← packed ID layout, bit helpers
    entity_registry.ts        ← slot allocation, generation tracking
  component/
    component.ts              ← ComponentDef phantom type, schema types
    component_registry.ts     ← schema storage, field index
  archetype/
    archetype.ts              ← dense table: columns, sparse-set, edges
    archetype_registry.ts     ← dedup, component index, query registration
  query/query.ts              ← Query<Defs>, SystemContext, cache, .and/.not/.or
  system/
    system.ts                 ← SystemFn, SystemConfig, SystemDescriptor types
    system_registry.ts        ← assigns SystemIDs, calls lifecycle hooks
  schedule/schedule.ts        ← phases, Kahn sort, flush boundaries
  type_primitives/
    bitset/bitset.ts          ← Uint32Array-backed BitSet, hash, contains, overlaps
    brand.ts                  ← Brand<T, Tag> phantom type utility
```
