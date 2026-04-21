# Best Practices (v0.3.0)

Practical guidance for building with oecs: patterns that work with the engine's grain, the trade-offs they imply, and pitfalls that bite if ignored.

This document does **not** repeat API reference or describe internals. For those, see:

- API reference: [`docs/api/`](./api/) — one file per subsystem.
- Internals: [`ARCHITECTURE.md`](./ARCHITECTURE.md) — data layout, flush model, cache invalidation rules.

Every example compiles against v0.3.0. Most are adapted directly from `src/__tests__/integration/` — that directory is the canonical reference for "does this actually work".

---

## 1. Designing components

### Prefer many small components over one fat component

Archetypes are keyed by the exact set of components attached to an entity. Queries filter on component masks. Both of these favour small, focused components:

- **Query selectivity.** A system that only needs `Pos` can write `world.query(Pos)` and iterate every entity that has a position, regardless of what else they have. If `Pos` is part of a fat `Transform { x, y, rotation, scale, parent, … }`, you iterate all of those fields' columns whether you touch them or not.
- **Archetype specialisation.** Adding a marker (e.g. `Frozen`) produces a new archetype. Systems that act only on frozen entities iterate just that archetype's rows. Bundling the frozen flag as `Transform.frozen` forces every consumer to branch in the inner loop.
- **Partial writes stamp fewer ticks.** `_changed_tick` is per `(archetype, component)` (see [change-detection.md](./api/change-detection.md)). Touching one field of `Pos` stamps `Pos` — not `Vel`, not `Health`. Fat components force change-detection observers to wake up for changes they don't care about.

```ts
// Good — each component has one responsibility
const Pos = world.register_component({ x: "f64", y: "f64" });
const Vel = world.register_component({ vx: "f64", vy: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });

// Avoid — one fat component forces every consumer to see every field
const Entity = world.register_component({
  x: "f64", y: "f64", vx: "f64", vy: "f64",
  hp: "i32", hp_max: "i32", frozen: "u8",
});
```

The counterpoint is **archetype fragmentation**: every unique component combination is a distinct archetype. Three independent boolean tags yield up to 2³ = 8 archetypes. Many of them may have only a handful of entities. When the combinations are large and sparse, consider packing related flags into a single `u8`-field component so you keep one archetype and filter per-entity in the loop. Trade ergonomics and query precision against archetype count.

### Pick the narrowest typed-array tag that fits

Columns are backed by concrete typed arrays (`component.ts` field_types → `TypedArrayFor[tag]`). Narrow types mean denser memory and better cache utilisation during iteration.

| Data                               | Tag           | Range                     |
| ---------------------------------- | ------------- | ------------------------- |
| Physics positions, velocities      | `"f64"`       | double precision          |
| Pixel coordinates, small reals     | `"f32"`       | 32-bit float              |
| Health, counters, signed integers  | `"i32"`       | ±2.1 × 10⁹                |
| Tile indices, small counts         | `"u16"`       | 0–65,535                  |
| Flags, small enums                 | `"u8"`        | 0–255                     |

```ts
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });
const Tile = world.register_component({ type: "u8", variant: "u8" });
```

Use array shorthand when every field shares a type. The default is `"f64"`:

```ts
const Vel = world.register_component(["vx", "vy"] as const);         // all f64
const Flags = world.register_component(["a", "b", "c"] as const, "u8"); // all u8
```

`as const` is load-bearing — without it, TypeScript widens to `string[]` and you lose field-level inference on `add_component`, `get_field`, `get_column`, and refs.

### Use tags for classification

A tag is `register_tag()` — a component with no fields. Tag archetypes take a fast path that skips column operations entirely (`Archetype.add_entity_tag` / `move_entity_from_tag`), and they're the cleanest way to express "this entity is a kind of X":

```ts
const IsEnemy = world.register_tag();
const IsPlayer = world.register_tag();
const Frozen = world.register_tag();
const Dead = world.register_tag();
```

Tags shine with `not()` and `and()`:

```ts
const alive = world.query(Health).not(Dead);
const enemies = world.query(Pos, Health).and(IsEnemy);
```

Tags have no columns, so `ctx.ref(Tag, e)` cannot be constructed. Tags participate in mask matching only.

---

## 2. Keys at module scope

`event_key`, `signal_key`, and `resource_key` each mint a fresh symbol on every call. Identity only survives across registrations if the key is a single module-scope `const`:

```ts
// keys.ts
import { event_key, signal_key, resource_key } from "oecs";

export const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");
export const GameOver = signal_key("GameOver");
export const Time = resource_key<{ delta: number; elapsed: number }>("Time");
```

Then import the key everywhere you emit, read, or access the resource:

```ts
import { DamageEvent, GameOver, Time } from "./keys";

world.register_event(DamageEvent, ["target", "amount"] as const);
world.register_signal(GameOver);
world.register_resource(Time, { delta: 0, elapsed: 0 });
```

Why this matters:

- `resource_key("Time")` inside a function body would produce a new symbol per call. Two sites that both call it would not see the same resource.
- Module scope also documents ownership: "this key lives here; register it once; import it elsewhere". Duplicate registration throws (`RESOURCE_ALREADY_REGISTERED`, `EVENT_ALREADY_REGISTERED`) — the error is loud, but the design intent is to avoid re-creating symbols at all.

---

## 3. Querying

### Narrow filters beat broad-plus-filter

`world.query(...)` uses an include mask, optional `not(...)` exclude, and optional `any_of(...)` — all three combine and are cached (see [queries.md](./api/queries.md)). The store keeps a live `Archetype[]` per registered query; iteration visits only non-empty archetypes.

Prefer the narrowest include set that expresses what the system needs:

```ts
// Good — include mask directly matches what the system reads
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
      const vx = arch.get_column(Vel, "vx");
      for (let i = 0; i < arch.entity_count; i++) px[i] += vx[i] * dt;
    });
  },
  (qb) => qb.every(Pos, Vel),
);

// Avoid — iterate everything with Pos, then branch
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      if (!arch.has_component(Vel as unknown as number)) return;
      // ...
    });
  },
  (qb) => qb.every(Pos),
);
```

### Pair queries with the system that reads them

Use the two-arg `register_system(fn, qb => qb.every(...))` form. The query resolves once at registration; the returned `Query` is captured in the system's closure. No repeated mask construction per frame:

```ts
const physicsSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => { /* ... */ });
  },
  (qb) => qb.every(Pos, Vel),
);
```

Ad-hoc `world.query(...)` calls are still cached — equivalent filters return the same `Query` instance — but the builder form makes the query's owner obvious and keeps it co-located with the system body.

### React to writes with `ChangedQuery`, not dirty flags

Every write through `get_column_mut`, `set_field`, `ref_mut`, or an archetype transition stamps the archetype's `_changed_tick[component]`. `ChangedQuery` yields archetypes whose stamp is `>= ctx.last_run_tick`:

```ts
const syncSys = world.register_system(
  (q, ctx) => {
    q.changed(Pos).for_each((arch) => {
      const px = arch.get_column(Pos, "x");
      const tx = arch.get_column_mut(Transform, "x", ctx.world_tick);
      for (let i = 0; i < arch.entity_count; i++) tx[i] = px[i];
    });
  },
  (qb) => qb.every(Pos, Transform),
);
```

This is cheaper and more reliable than a `u8 dirty` field you maintain by hand: no forgotten resets, no accidental iteration over stale flags, no extra column. Granularity is per-archetype — see section 7.

---

## 4. `ref` vs `ref_mut`

`ctx.ref(def, e)` returns a read-only `ReadonlyComponentRef<S>`; writing through it is a compile error. `ctx.ref_mut(def, e)` returns a writable `ComponentRef<S>` **and** stamps `_changed_tick[def] = store._tick` at the moment of creation (`query.ts:269`).

The two cost the same per field access; the only extra work `ref_mut` does is one array write at construction. But that single write is visible to every downstream `query.changed(def)` consumer:

```ts
// Read-only: no tick bump
const pos = ctx.ref(Pos, player);
ctx.emit(LogPos, { x: pos.x, y: pos.y });

// Mutable: stamps Pos even if you never assign
const pos = ctx.ref_mut(Pos, player);
pos.x += dt; pos.y += dt;
```

Guard rails:

- **Writing through `ref` is a type error**, not a silent no-op. The compiler catches it.
- **Creating `ref_mut` you never write through still bumps the tick.** This will wake up every `q.changed(Pos)` observer this frame. Use `ref` when reading, `ref_mut` at the point of mutation.
- **Do not hold refs across a flush.** Refs snapshot the archetype's column buffers and the entity's row. Any structural change (add/remove component, destroy, manual `ctx.flush()`) may move the entity, invalidating the snapshot. Rebuild the ref after the flush.
- **Refs are for per-entity access**, not bulk iteration. For hot loops, read columns directly via `arch.get_column` / `arch.get_column_mut`.

---

## 5. System ordering

### Use labels and `before` / `after`

Within a phase, systems are topologically sorted using `before` / `after` constraints, with `insertion_order` as a deterministic tiebreaker (see [schedule.md](./api/schedule.md)). Always express real dependencies as constraints — never rely on phase boundaries between unrelated systems:

```ts
world.add_systems(
  SCHEDULE.UPDATE,
  inputSys,
  { system: moveSys, ordering: { after: [inputSys] } },
  { system: collisionSys, ordering: { after: [moveSys] } },
);
```

If A must see B's writes this frame, put them in the same phase with an explicit `after: [B]`. Don't put A in `POST_UPDATE` and B in `UPDATE` unless the phase split is itself semantically meaningful.

Cycles throw `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` on the first run after the cycle is introduced. The check is never stripped in production — design your ordering as a DAG.

### Keep systems single-purpose

One observable effect per system. This makes ordering easy to reason about and lets you schedule independently:

```ts
// Good
const applyInputSys = /* read Input resource → write Vel */;
const moveSys = /* read Vel → write Pos */;
const collideSys = /* read Pos → write Vel, emit Collision events */;

// Avoid
const everythingSys = /* input + move + collide + render */;
```

Small systems also make change-detection cleaner: a change-detection observer that depends on moveSys's writes only needs `ordering: { after: [moveSys] }`, not a whole phase worth of unrelated systems.

### Prefer `insertion_order` determinism over hidden assumptions

When no `before` / `after` binds two systems, the scheduler falls back to insertion order. This is a feature — the sort is deterministic across runs for a fixed registration order — but don't lean on it for correctness-critical ordering. If system B must run after system A, say so:

```ts
// Explicit — survives reordering of add_systems calls
world.add_systems(SCHEDULE.UPDATE, a, { system: b, ordering: { after: [a] } });
```

---

## 6. Change detection patterns

### Observe writes with `q.changed(...)`

Stand up a query that includes the watched component, then call `.changed(...)` inside the system body. This mirrors the integration test pattern: a writer system stamps a component, and an observer ordered `after` the writer reacts:

```ts
const detector = world.register_system(
  (q) => {
    q.changed(Pos).for_each((arch) => { /* react to Pos-touched archetypes */ });
  },
  (qb) => qb.every(Pos, Vel),
);

world.add_systems(
  SCHEDULE.UPDATE,
  writer,
  { system: detector, ordering: { after: [writer] } },
);
```

The `after: [writer]` is what makes the writer's tick visible: `ChangedQuery` yields archetypes whose stamp is `>= ctx.last_run_tick`, and `last_run_tick` is set per-dispatch.

### The `last_run_tick = 0` first-run case

A system's `last_run_tick` is `0` until it runs once. On the first dispatch, *every* non-empty matching archetype has `_changed_tick >= 0`, so a `ChangedQuery` fires for every row. If that's not what you want, guard explicitly:

```ts
const observer = world.register_system(
  (q, ctx) => {
    if (ctx.last_run_tick === 0) return;   // skip the "everything looks changed" first run
    q.changed(Pos).for_each((arch) => { /* ... */ });
  },
  (qb) => qb.every(Pos),
);
```

### Structural transitions stamp the destination

`add_component` / `remove_component` move the entity into a (possibly new) archetype. The destination's `_changed_tick` is stamped for every component present on it, not just the one that triggered the transition (`ARCHITECTURE.md` §14.10). A watcher on `q.changed(Pos)` fires when an entity gains `Frozen` if both archetypes include `Pos`.

If you need to distinguish "field write" from "transition arrival", track it explicitly — for example by stamping a sidecar component on the write path and filtering on that.

### Resources aren't tick-tracked; use an event

`set_resource` writes into a `Map<symbol, unknown>` with no versioning. `ChangedQuery` cannot observe it. If another system needs to react to a resource change, emit an event instead:

```ts
const ConfigChanged = signal_key("ConfigChanged");
world.register_signal(ConfigChanged);

const setter = world.register_system((ctx) => {
  ctx.set_resource(Config, { speed: 99 });
  ctx.emit(ConfigChanged);
});

const reactor = world.register_system((ctx) => {
  if (ctx.read(ConfigChanged).length === 0) return;
  // Rebuild derived state here
});
```

Alternatively, keep a version counter inside the resource value itself.

---

## 7. Events vs signals

Signals and events share the same lifecycle — emit during one `update()` call, visible to every subsequent system in that call, cleared before the next one. The difference is payload storage:

- `event_key<F>(name)` + `register_event(key, fields)` — structured payload, one column per field.
- `signal_key(name)` + `register_signal(key)` — no payload, just a counter.

Use the simpler one:

```ts
// Structured: you need per-emit data
export const Damage = event_key<readonly ["target", "amount"]>("Damage");
world.register_event(Damage, ["target", "amount"] as const);

ctx.emit(Damage, { target: e, amount: 50 });

const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) {
  apply_damage(dmg.target[i] as EntityID, dmg.amount[i]);
}

// Signal: you only need "did this happen"
export const OnPause = signal_key("OnPause");
world.register_signal(OnPause);

ctx.emit(OnPause);
if (ctx.read(OnPause).length > 0) { /* paused */ }
```

Don't register events you don't emit every frame — each channel holds its columns across the run and `clear()` still touches them per `update()`. For rare one-offs, prefer a resource or a direct method call at the right seam.

---

## 8. Entity lifecycle

### `EntityID` is a 31-bit packed handle, not a pointer

`[generation:11][index:20]`. Destruction bumps the slot's generation and pushes the index onto a free list. A stale handle still points at the right slot, but the generation no longer matches and `is_alive(id)` returns `false`.

In `__DEV__`, stale handles passed to `get_field`, `set_field`, `ref`, `ref_mut`, `has_component`, `add_component`, `remove_component`, and `destroy_entity` throw `ECS_ERROR.ENTITY_NOT_ALIVE`. In production these guards are tree-shaken, so reads and writes against a dead handle silently target whatever lives in the (possibly-recycled) slot.

### Revalidate handles stored across frames

Entity IDs held in events, closures, resources, or plain variables must be re-checked with `is_alive` before use:

```ts
// BAD — target could have been destroyed this frame by another system
const hp = ctx.get_field(target, Health, "current");

// GOOD — guard first
if (world.is_alive(target)) {
  const hp = ctx.get_field(target, Health, "current");
  ctx.set_field(target, Health, "current", hp - damage);
}
```

Entity IDs obtained inside `q.for_each` are implicitly alive for the duration of that callback — `for_each` never yields dead rows.

### Prefer one flush boundary over many

Every structural change (add component, remove component, transition) costs an archetype move: allocate a row in the destination, copy shared columns, swap-remove from the source. When building an entity, use `add_components` so the entity reaches its final archetype in a single move:

```ts
// Single archetype transition — one move
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: Health, values: { current: 100, max: 100 } },
  { def: IsEnemy },
]);
```

For whole-archetype changes — e.g. "every entity with `Frozen` gets `Slow`" — use `world.batch_add_component(arch, Def)` / `world.batch_remove_component(arch, Def)`. These use `bulk_move_all_from`, which delegates to `TypedArray.set()` for column-copy — much faster than per-entity moves.

---

## 9. Resources

Resources are the right home for frame-scoped or world-scoped singletons: time/delta, input snapshots, camera transforms, config objects, asset tables, audio engines.

```ts
export const Time = resource_key<{ delta: number; elapsed: number }>("Time");
world.register_resource(Time, { delta: 0, elapsed: 0 });

const advanceTime = world.register_system((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});
world.add_systems(SCHEDULE.PRE_UPDATE, advanceTime);
```

When they are the wrong tool:

- **Per-entity data.** Use components. Resources are singletons — not filterable, iterable, or tick-tracked.
- **Cross-frame persistence of structured data.** If it needs change detection, query filtering, or lifecycle tracking, it wants to be components on entities.
- **A fake singleton entity.** Don't create an entity carrying a `GlobalState` component — that's what resources are.

Resources return the same reference on every read. Mutating an object-shaped resource through `ctx.resource(key)` avoids allocating a new object; use `set_resource` only to swap the whole value.

---

## 10. Working with the store directly

`SystemContext.store` is publicly exposed as an escape hatch. Reaching for it is almost always a sign that a query would do the job — iterate archetypes via `world.query(...)` / `q.for_each`; look up a component's field on a single entity via `ctx.ref` / `ctx.ref_mut` / `ctx.get_field` / `ctx.set_field`.

Genuine reasons to touch `ctx.store`: debugging / diagnostics (counting archetypes, dumping metadata), or building a low-level utility the public facade does not express.

When you do reach in, stay within the flush contract: structural changes routed through `SystemContext` (`ctx.add_component`, `ctx.remove_component`, `ctx.destroy_entity`) are buffered and applied at phase boundaries so iterators stay valid. Calling the immediate `ECS`-facade variants (`world.add_component`, …) from inside a system bypasses the buffer and can shuffle archetype membership mid-iteration.

---

## 11. Using type primitives directly

`BitSet`, `SparseSet`, `SparseMap<V>`, `GrowableTypedArray` (+ all concrete subclasses), `BinaryHeap<T>`, and `topological_sort` are exported from the package root. See [type-primitives.md](./api/type-primitives.md) for the full API.

Reach for them when:

- You need an O(1) integer-keyed set (entities seen this frame) — `SparseSet`.
- You need a priority queue (scheduler, A*, event timeline) — `BinaryHeap<T>` with a `CompareFn<T>`.
- You need a growable numeric buffer you can hand to WebGL/WebGPU or batch-copy with `TypedArray.set()` — `GrowableFloat32Array` / `GrowableInt32Array` / etc.
- You need a dense bitmask with `contains` / `overlaps` — `BitSet`.

These are the same primitives the ECS uses internally (archetype columns, scheduler ready queue, archetype masks). If you're reimplementing swap-and-pop over a `number[]`, you want `SparseSet`; if you're building a growable numeric array, you want `GrowableTypedArray`.

---

## 12. Anti-patterns

**Iterating past `arch.entity_count`.** Typed-array columns are backed by doubling `GrowableTypedArray` buffers — the raw `.buf` is longer than the logical length. Always loop to `arch.entity_count`, never to `column.length`. Hoist `arch.get_column(...)` once per archetype; the reference is stable for the `for_each` callback but not across frames.

**Storing refs in plain objects.** `ctx.ref(def, e)` / `ctx.ref_mut(def, e)` snapshot the archetype, the row, and the backing buffers. Stashing a ref on an object that outlives the system body invites use-after-flush — the next `add_component` / `destroy` can move the entity. Rebuild refs each frame; `Object.create(proto)` is near-free.

**Using resources as per-entity storage.** A `Map<EntityID, {...}>` inside a resource re-implements component storage, poorly: you lose archetype co-location, query filtering, SoA iteration, change detection, and orphan destroyed entities. If the data is per-entity, it's a component.

**Casting `ReadonlyComponentRef` to `ComponentRef`.** The readonly marker is how the compiler enforces "this system only reads Pos" so `q.changed(Pos)` observers stay correct. If you mean to write, use `ref_mut` at the point of mutation.

**Using `ref_mut` for reads.** `ref_mut` stamps the archetype at construction, before any assignment. A `ref_mut` you never write through still wakes up every `q.changed(...)` observer. Reach for `ref_mut` at the point of mutation; read through `ref`.

---

## 13. Testing

`src/__tests__/integration/` is the canonical usage reference. Each file exercises one subsystem end-to-end against a real `ECS` instance:

- `query.test.ts`, `tag.test.ts` — query caching, `not()` / `any_of()`, live archetype growth.
- `change_detection.test.ts` — tick stamping, `ChangedQuery`, structural transitions.
- `event.test.ts`, `resource.test.ts` — emit/read within a frame; register/read/write.
- `ref.test.ts` — `ref` / `ref_mut`, readonly enforcement, invalidation after flush.
- `schedule.test.ts`, `system.test.ts` — phase order, ordering, lifecycle hooks, flush.
- `store.test.ts` — archetype graph, entity lifecycle, generational handle behaviour.

Prefer integration-style tests for your own code: construct a world, register what you need, drive `world.update(dt)`, assert on observable state. Mocking `SystemContext` or the store tends to fossilise internals and miss cross-subsystem bugs (flush ordering, change-tick propagation, ref invalidation after transitions). The API is cheap enough to stand up in a test — use it. When a test fails, read the matching integration test for that subsystem; if the invariant you're relying on isn't asserted there, it may not exist.
