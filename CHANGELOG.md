# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-21

A substantial release focused on change detection, stricter component-access
typing, and a simpler key-based API for events and resources. Several public
entry points change shape; see the migration notes under *Breaking changes*.

### Added

#### Change detection

- Frame-based tick counter on the world. `ECS` now holds a `_tick` that
  advances once per `update()`. Systems can see it via `ctx.world_tick`,
  and each `SystemContext` receives `last_run_tick` — the tick at which that
  system last executed.
- Per-component change ticks on archetypes. Each archetype tracks
  `_changed_tick[component_id]` — the tick at which any entity in that
  archetype last had the component mutated. Maintained automatically by
  `write_fields`, `write_fields_positional`, `copy_shared_from`,
  `move_entity_from`, and `bulk_move_all_from`, all of which now accept a
  `tick` parameter.
- `ChangedQuery<Defs>` — a new query variant, produced by `query.changed(...)`,
  that restricts iteration to archetypes whose tracked components were
  modified after `last_run_tick`. Validates at construction that the named
  components are part of the parent query's include set.

#### Readonly component views

- `ReadonlyColumn<T>` and `ReadonlyUint32Array` — compile-time readonly views
  of typed-array columns. Returned by `archetype.get_column()` and the new
  `archetype.entity_ids` getter. Prevents accidental indexed writes at the
  type level; zero runtime cost.
- `ReadonlyComponentRef<S>` — readonly variant of `ComponentRef`. Returned by
  `query.ref(...)`. Use it when you only need to read component fields.
- `archetype.get_column_mut(def, field, tick)` — explicit mutable column
  accessor. Writes through `get_column_mut` update `_changed_tick`.
- `query.ref_mut(...)` — mutable sibling of `ref()`. Returns a `ComponentRef`
  and records the component as changed for the current tick.

#### Key-based Event API

- `EventKey<F>` — symbol-typed key that carries the event's field schema as
  a phantom type.
- `event_key<F>(name)` / `signal_key(name)` — factories for module-scope
  event keys. `signal_key` is a convenience wrapper for zero-field events.

#### Key-based Resource API

- `ResourceKey<T>` — symbol-typed key carrying the resource's value type as
  a phantom type.
- `resource_key<T>(name)` — factory for module-scope resource keys.
- `world.has_resource(key)` — existence check.
- Resources are now plain key→value storage. `world.resource(key)` returns
  the stored `T` directly.

#### Errors

- New `ECS_ERROR` categories: `RESOURCE_ALREADY_REGISTERED`,
  `EVENT_ALREADY_REGISTERED`, `EVENT_NOT_REGISTERED`.
- New `TYPE_ERROR` category: `ASSERTION_FAIL_NON_NULLABLE`, emitted by the
  new `assert_non_null` helper.

#### Assertions

- `assert_non_null<T>(value, message?)` in `type_primitives/assertions` —
  dev-only (`__DEV__` guarded) assertion that narrows `T` to `NonNullable<T>`
  and throws a `TypeError` with contextual info on failure.

#### New primitives

- `BinaryHeap<T>` in `type_primitives/binary_heap` — generic array-backed
  heap with a user-supplied comparator. `push`, `pop`, `peek`, `clear`,
  `size`. O(log n) push/pop, O(1) peek.
- `topological_sort<T>(nodes, edges, tiebreaker, node_name?)` in
  `type_primitives/topological_sort` — Kahn's algorithm with a
  `BinaryHeap`-backed ready queue for deterministic tie-breaking. Throws
  `TypeError` on cycles; the schedule layer re-wraps as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.

#### Public exports

- `SystemFn`, `ReadonlyComponentRef`, `ChangedQuery`, `ReadonlyColumn`,
  `ReadonlyUint32Array`, `EventKey`, `event_key`, `signal_key`,
  `ResourceKey`, `resource_key` are now part of the package surface.

### Changed

- Query iteration is callback-based. `Query` no longer implements
  `[Symbol.iterator]`. Iterate with `query.for_each((archetype) => { ... })`.
- `world.register_event`, `world.register_signal`, and `world.register_resource`
  return `void` and take an `EventKey` / `ResourceKey` as their first argument.
- `world.emit`, `world.read`, `world.resource`, and `world.set_resource`
  accept keys instead of definition objects. `world.resource(key)` returns
  the typed value `T` directly rather than a field-reader wrapper.
- Schedule execution methods take a tick. `run_startup(label, tick)`,
  `run_update(label, tick)`, and `run_fixed_update(label, tick)` require
  the current frame tick. `ECS.update()` wires this automatically.
- System ordering now uses the shared `topological_sort` primitive. Observable
  behavior is unchanged: `before`/`after` constraints respected,
  `insertion_order` remains the tie-breaker, cycles surface as
  `ECSError(CIRCULAR_SYSTEM_DEPENDENCY)`.
- Store/query wiring. The store keeps a reference to each active `Query` via
  `update_query_ref` and calls `mark_non_empty_dirty` only when structural
  changes occur, avoiding spurious query rebuilds on stable frames.
- Bit-manipulation and hash constants (`BITS_PER_WORD`, `BITS_PER_WORD_SHIFT`,
  `BITS_PER_WORD_MASK`, `FNV_OFFSET_BASIS`, `FNV_PRIME`) are exported from
  `type_primitives/bitset` rather than `utils/constants`.
- Growable-array defaults (`DEFAULT_INITIAL_CAPACITY`, `GROWTH_FACTOR`) are
  exported from `type_primitives/typed_arrays`.

### Fixed

- Query dirty propagation. `flush_destroyed` now marks affected queries dirty
  so subsequent iteration sees the correct archetype set. `flush_structural`
  skips dirty marking when no changes occurred.
- `set_field` on the world goes through `get_column_mut` with the current
  tick, so mutations via the high-level API are visible to `ChangedQuery`.

### Removed

- `ResourceChannel`, `ResourceDef<F>`, `ResourceReader<F>`, `ResourceID`,
  `as_resource_id`, and the `__resource_schema` marker symbol — the entire
  SoA column-based resource storage layer. Resources are now key→value.
- `RESOURCE_ROW` constant — unused.
- `EventDef<F>` — replaced by `EventKey<F>`.

### Breaking changes

1. **Event definitions.** Define a key at module scope, then register and use it:
   ```ts
   // before
   const damage = world.register_event({ amount: "u32" } as const);
   world.emit(damage, { amount: 5 });

   // after
   const DAMAGE = event_key<{ amount: "u32" }>("damage");
   world.register_event(DAMAGE, { amount: "u32" } as const);
   world.emit(DAMAGE, { amount: 5 });
   ```

2. **Resource registration / access.**
   ```ts
   // before
   const clock = world.register_resource({ ms: "u32" } as const, { ms: 0 });
   const ms = world.resource(clock).ms;

   // after
   const CLOCK = resource_key<{ ms: number }>("clock");
   world.register_resource(CLOCK, { ms: 0 });
   const ms = world.resource(CLOCK).ms;
   ```
   `world.resource()` returns the stored value directly; the reader wrapper
   and the SoA column storage are gone.

3. **Query iteration.**
   ```ts
   // before
   for (const arch of query) { ... }

   // after
   query.for_each((arch) => { ... });
   ```

4. **Mutable vs readonly refs.** `query.ref(...)` now returns
   `ReadonlyComponentRef`. Switch to `query.ref_mut(...)` when writing —
   this is also what enables change detection for that component.

5. **Archetype column access.** `archetype.get_column(...)` returns a
   `ReadonlyColumn`. Use `archetype.get_column_mut(def, field, tick)` for
   direct writes. Most callers should use `query.ref_mut` and won't notice.

6. **Schedule driver signatures.** If you drive the scheduler directly
   (bypassing `ECS.update()`), `run_startup`, `run_update`, and
   `run_fixed_update` now require a `tick: number` argument.

## [0.1.x]

Prior releases — see git history.
