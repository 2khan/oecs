# Change Detection

Change detection in oecs is tick-based. The world maintains a monotonic `_tick` counter that advances by one per `update()`. Every archetype tracks, per component, the last tick at which any of that component's columns were mutated. A `ChangedQuery` filters the base query's archetypes to just those whose chosen component's change tick is recent enough to be considered "changed" from the observing system's perspective.

The unit of granularity is the archetype, not the entity. Mutating one entity's position stamps the archetype's `Pos` change tick — the whole archetype is flagged for that component.

## The tick model

There are two ticks that matter to a system:

- `ctx.world_tick` — the world's current tick. Exposed via `SystemContext.world_tick`, which reads `store._tick`. At the start of `ECS.update()`, `store._tick` is synced to the world's `_tick`; after all phases run, `_tick` is incremented. Startup runs with tick `0`.
- `ctx.last_run_tick` — the tick stamped on the system before it executes. The schedule assigns `ctx.last_run_tick = tick` immediately before calling the system's `fn`, so during a system's body `last_run_tick` equals the current world tick at the moment that system was dispatched.

`ChangedQuery` iterates archetypes whose change tick is `>= ctx.last_run_tick`. Writes that land on the same tick as the observing system (earlier in the same phase ordering, or during the current fixed-step pass) are visible; writes from a prior `update()` are not.

```ts
public get world_tick(): number {
  return this.store._tick;
}

public last_run_tick: number = 0;
```

## What counts as a change

A mutation is recorded when any code path writes to an archetype's columns through a tick-aware method. The archetype exposes these write surfaces:

- `arch.get_column_mut(def, field, tick)` — returns the mutable `Float32Array` / `Float64Array` / `Int32Array` / etc. for a field and stamps `_changed_tick[def] = tick` before returning.
- `arch.write_fields(row, component_id, values, tick)` and `arch.write_fields_positional(row, component_id, values, tick)` — record-style and positional single-row writes used by `add_component` / `batch_add_component` / `set_field`.
- `arch.copy_shared_from(src, src_row, dst_row, tick)` — column copy during partial archetype moves.
- `arch.move_entity_from(src, src_row, entity_id, transition_map, tick)` and `arch.bulk_move_all_from(src, transition_map, tick)` — full entity moves. Every component present on the *destination* archetype is stamped at `tick`, because entity migration reshapes the destination's column population.

What the world and `SystemContext` expose on top of those:

- `ctx.set_field(e, def, field, value)` and `world.set_field(...)` call `get_column_mut(def, field, store._tick)`.
- `ctx.ref_mut(def, e)` stamps `arch._changed_tick[def] = store._tick` at the moment the ref is created, regardless of whether the caller writes through it.
- `world.add_component` / `world.remove_component` / `world.add_components` / `world.remove_components` (and their deferred `ctx.*` counterparts) cause an archetype transition, which stamps every column on the destination archetype for the transition's tick.

What does **not** record a change:

- `arch.get_column(def, field)` (read-only `ReadonlyColumn`).
- `world.get_field(e, def, field)` and `ctx.get_field(...)`.
- `ctx.ref(def, e)` (read-only ref).
- Reading `arch.entity_ids` or iterating via `q.for_each` alone.

```ts
// Read — no change recorded
arch.get_column(Pos, "x");

// Write — stamps _changed_tick[Pos] = ctx.world_tick
const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
px[0] = 1;
```

## `Query.changed()` and `ChangedQuery`

Any `Query<Defs>` has a `changed(...defs)` method that returns a `ChangedQuery<Defs>`:

```ts
public changed(...defs: ComponentDef[]): ChangedQuery<Defs>;
```

`ChangedQuery` exposes a single iteration method:

```ts
public for_each(cb: (arch: Archetype) => void): void;
```

Internally it reads the observer's `ctx.last_run_tick`, walks the base query's non-empty archetypes, and for each archetype yields it if any of the named components' `_changed_tick` is `>= last_run_tick`:

```ts
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
```

Passing multiple components produces an OR: an archetype is yielded if *any* of the listed components was changed.

Every component passed to `changed()` must already be in the base query's include mask. In `__DEV__` builds the constructor throws `ECS_ERROR.COMPONENT_NOT_REGISTERED` otherwise:

```ts
q.changed(Vel);            // valid only if q was built with every(Pos, Vel) (or similar including Vel)
q.changed(Transform);      // throws in dev if Transform is not in q's include mask
```

The returned `ChangedQuery` is a thin wrapper; it is cheap to create inside a system body, though caching the base `Query` at registration time and calling `.changed(...)` per frame is the idiomatic pattern.

## Full example

This mirrors the integration test pattern: one system writes a field, a second system — ordered `after` the writer — reacts only to the archetypes that were touched.

```ts
import { ECS, SCHEDULE } from "oecs";

const world = new ECS();
const Pos = world.register_component(["x", "y"] as const);
const Vel = world.register_component(["vx", "vy"] as const);

const e = world.create_entity();
world.add_component(e, Pos, { x: 0, y: 0 });
world.add_component(e, Vel, { vx: 1, vy: 1 });

const writer = world.register_system(
  (q, ctx) => {
    q.for_each((arch) => {
      // Stamps _changed_tick[Pos] = ctx.world_tick for this archetype
      const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
      for (let i = 0; i < arch.entity_count; i++) px[i] += 1;
    });
  },
  (qb) => qb.every(Pos, Vel),
);

let change_count = 0;
const detector = world.register_system(
  (q) => {
    q.changed(Pos).for_each(() => {
      change_count++;
    });
  },
  (qb) => qb.every(Pos, Vel),
);

world.add_systems(
  SCHEDULE.UPDATE,
  writer,
  { system: detector, ordering: { after: [writer] } },
);
world.startup();

world.update(1 / 60);  // writer stamps Pos; detector observes one changed archetype
world.update(1 / 60);  // same again — each frame the stamp matches last_run_tick
```

If the ordering were flipped — detector before writer — the write would happen *after* the detector ran, so the archetype's `_changed_tick` for `Pos` would trail `ctx.last_run_tick` and the detector would not see it until the next frame's writer stamped the archetype again.

## Granularity

Change ticks are per `(archetype, component)`. Mutating one row in a column stamps the whole archetype for that component, and the `ChangedQuery` yields the archetype — not a subset of its rows.

```ts
q.for_each((arch) => {
  const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
  px[0] = 42;   // one entity written — the entire archetype is "changed for Pos"
});

// All rows in the archetype show up, including rows whose Pos was not touched:
q.changed(Pos).for_each((arch) => {
  for (let i = 0; i < arch.entity_count; i++) { /* ... */ }
});
```

If you need per-entity change filtering, do it yourself inside the callback by comparing against a previous value stored in a sidecar component.

## Why this design

- **Compact storage.** One integer per component per archetype (`_changed_tick: number[]`) — not per entity. Adding change detection to an ECS with millions of entities costs kilobytes, not megabytes.
- **SoA-aligned.** The same `for_each(arch => ...)` loop you write for normal iteration is the loop a `ChangedQuery` gives you. No branches inside the inner row loop.
- **No per-write overhead.** The write path stamps a single sparse-array slot (`arch._changed_tick[cid] = tick`) once per mutable accessor, regardless of how many rows the caller subsequently writes.

## Pitfalls

- **Archetype granularity is load-bearing.** If you have a single archetype containing 10,000 entities and you touch one of them, every consumer of `q.changed(Pos).for_each(...)` will see that archetype. This is usually cheap because the consumer still iterates only over the archetype's rows, but if your observer does an O(n) allocation per archetype it can be misleading.
- **Structural transitions stamp the destination.** `add_component`, `remove_component`, and their deferred forms move the entity into a new (or existing) destination archetype and stamp every component on that destination at the current tick. An observer watching `q.changed(Pos)` will fire for any entity that crosses into an archetype that happens to include `Pos`, even if the caller's intent was only "add `Tag`". See the integration test `structural transition ticks all components on destination archetype` for the exact shape.
- **`ref_mut` stamps eagerly.** Calling `ctx.ref_mut(Pos, e)` stamps the archetype even if your code never writes through the returned ref. If you end up only reading, use `ctx.ref(Pos, e)` instead.
- **`last_run_tick` is per-dispatch.** A system that is added to `PRE_UPDATE` and again to `POST_UPDATE` is two distinct `SystemDescriptor`s but shares one `SystemContext`; each dispatch overwrites `ctx.last_run_tick` just before that dispatch runs. Change-detection logic that assumes a stable "this system's previous run" needs to own that state explicitly — the context does not track per-system history.
- **Resources are not tracked.** `world.set_resource` / `ctx.set_resource` write into a `Map<symbol, unknown>`; resources have no archetype, no column, and no `_changed_tick`. If you need change detection on a resource, wrap it in a component on a sentinel entity or keep a version number inside the resource value.
- **`add_entity` zero-fill is not a change.** `Archetype.add_entity` pushes zeros into every column without touching `_changed_tick`. The stamp comes from the subsequent `write_fields` inside `add_component` — not from the row allocation itself.

## Exports

From `oecs`:

```ts
import { Query, ChangedQuery, SystemContext } from "oecs";
```

`Query.changed(...)` is the canonical entry point; `ChangedQuery` is re-exported for type annotations. `ctx.world_tick` and `ctx.last_run_tick` are fields on `SystemContext`.
