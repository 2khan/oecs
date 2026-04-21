# Queries

Queries are the system-facing view over an archetype-based world. A `Query<Defs>` matches archetypes whose component mask satisfies a set of include / exclude / any-of filters, and exposes those archetypes for direct Structure-of-Arrays iteration.

Queries operate at the archetype level, not per entity: iteration hands you each matching `Archetype`, and you write the inner loop yourself using the typed-array columns. Matching is lazy and live — the result set is populated once from the existing archetype graph, then new archetypes are pushed into it as they are created.

Three filter kinds combine freely:

- `include` — required components (every archetype must contain all of these).
- `exclude` (`not`) — archetypes containing any of these are filtered out.
- `any_of` — archetype must contain at least one of these.

## Exports

From `oecs`:

- `Query` — live, filtered view over archetypes.
- `QueryBuilder` — used inside `register_system` to resolve a query at registration time.
- `ChangedQuery` — filters a base query's archetypes by component change tick.
- `SystemContext` — the `ctx` parameter passed to systems; exposes `ref`, `ref_mut`, deferred mutations, events, and resources.

## Building a query

`world.query(...defs)` is variadic and returns a `Query<Defs>` whose include mask is the set of passed components. Component order does not matter.

```ts
const q = world.query(Pos, Vel);
```

To add exclude or any-of filters, chain:

```ts
// Extend required components (adds to include mask)
const q = world.query(Pos).and(Vel);

// Exclude archetypes containing any of these components
const alive = world.query(Pos).not(Dead);

// Require at least one of these
const damaged = world.query(Health).any_of(Poison, Fire);

// Combine freely
const targets = world
  .query(Pos)
  .and(Health)
  .not(Shield)
  .any_of(IsEnemy, IsBoss);
```

Each chain method returns a new (cached) `Query`; the original is unchanged.

Inside `register_system`, use `QueryBuilder.every(...)` to build the query once at registration:

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      // ...
    });
  },
  (qb) => qb.every(Pos, Vel),
);
```

Counts:

```ts
q.count();            // total entities across all matching archetypes
q.archetype_count;    // number of matching archetypes (including empty ones)
q.archetypes;         // readonly Archetype[] — all matches (empties included)
```

## Iterating with `for_each`

Iterate non-empty archetypes via the callback form. `Symbol.iterator` is not implemented — use `for_each` exclusively.

```ts
q.for_each((arch) => {
  const px = arch.get_column(Pos, "x");
  const py = arch.get_column(Pos, "y");
  const vx = arch.get_column(Vel, "vx");
  const vy = arch.get_column(Vel, "vy");
  const n = arch.entity_count;
  for (let i = 0; i < n; i++) {
    px[i] += vx[i];
    py[i] += vy[i];
  }
});
```

Key archetype members used inside the callback:

- `arch.entity_count` — number of live entities in this archetype.
- `arch.entity_ids` — `ReadonlyUint32Array` of entity IDs; valid at indices `0..entity_count-1`.
- `arch.get_column(def, field)` — read-only typed-array column.
- `arch.get_column_mut(def, field, tick)` — mutable typed-array column; records `tick` as the component's change tick (see `ctx.world_tick`).

Empty archetypes are skipped automatically. The non-empty list is cached and invalidated lazily when entities are added, removed, or moved between archetypes.

If you need the entity ID for side effects:

```ts
q.for_each((arch) => {
  const ids = arch.entity_ids;
  const hp = arch.get_column(Health, "current");
  const n = arch.entity_count;
  for (let i = 0; i < n; i++) {
    if (hp[i] <= 0) ctx.destroy_entity(ids[i] as EntityID);
  }
});
```

## Single-entity refs: `ctx.ref` and `ctx.ref_mut`

When you need repeated field access to a single entity (not bulk iteration), use refs from the system context. These are not query methods — they live on `SystemContext` — but they pair naturally with queries that produce individual entity IDs.

```ts
// Read-only ref
const pos: ReadonlyComponentRef<PosSchema> = ctx.ref(Pos, entity);
const x = pos.x;

// Mutable ref — records a write tick on the component's archetype
const vel: ComponentRef<VelSchema> = ctx.ref_mut(Vel, entity);
vel.vx += 1;
```

`ctx.ref(def, entity)` returns a `ReadonlyComponentRef<S>`: each schema field is readable as a `number` property.

`ctx.ref_mut(def, entity)` returns a mutable `ComponentRef<S>` and sets `archetype._changed_tick[def] = store._tick` at the moment of creation. This is what makes the entity (and its archetype) visible to `ChangedQuery` consumers on the next run.

See [refs.md](./refs.md) for the full ref lifecycle and when to prefer them over `get_column` / `get_field`.

## `ChangedQuery` — filtering by change tick

`query.changed(...defs)` produces a `ChangedQuery<Defs>` that iterates only archetypes where at least one of the listed components was written after the system's last run.

```ts
const qMoved = q.changed(Pos);

qMoved.for_each((arch) => {
  // Only archetypes whose Pos column was touched since ctx.last_run_tick.
  const px = arch.get_column(Pos, "x");
  const py = arch.get_column(Pos, "y");
  // ...
});
```

Behavior:

- Each listed component must be part of the base query's include mask; otherwise `changed()` throws in dev.
- The threshold is `ctx.last_run_tick`, read from the ECS at iteration time.
- An archetype is emitted if any of the tracked components has `_changed_tick >= last_run_tick`.
- Writes that bump `_changed_tick` come from `get_column_mut`, `ref_mut`, `set_field`, `write_fields`, `write_fields_positional`, and archetype transitions (add / remove / move).

`ChangedQuery` reuses the base query's non-empty archetype cache — it does not allocate a new result set.

## Query caching

`world.query(...)` is internally deduplicated. The ECS hashes `(include, exclude, any_of)` into a bucketed cache and returns the same `Query` instance for equivalent filter sets. Calls like `world.query(Pos, Vel)` and `world.query(Vel, Pos)` resolve to the same object.

Each cached query holds two things:

1. A live `Archetype[]` result set. The store pushes every newly created archetype into every registered query whose masks it satisfies, so queries never go stale.
2. A non-empty subset list, rebuilt lazily. It is marked dirty on structural change (new archetype, entity add/remove) and recomputed on the next `for_each` call.

Cache hits skip mask construction entirely; cache misses allocate a new `Query`, copy the masks, and register the result with the store.

## Common patterns

**System-scoped query** — resolve once, iterate every frame:

```ts
world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      // ...
    });
  },
  (qb) => qb.every(Pos, Vel),
);
```

**Ad-hoc query** — build when needed; still cached:

```ts
const living = world.query(Health).not(Dead);
console.log("alive:", living.count());
```

**Change-detection system** — react only to modified entities:

```ts
world.register_system(
  (q, ctx, dt) => {
    const moved = q.changed(Pos);
    moved.for_each((arch) => {
      // rebuild spatial index for this archetype's slice
    });
  },
  (qb) => qb.every(Pos),
);
```

**Narrow vs. broad filters** — prefer narrow include masks for hot loops; broad masks with `not(...)` when the exclusion set is small. Both produce the same correct result; the non-empty archetype list and cache hit behavior make either shape cheap at iteration time.

**Deferred mutation inside iteration** — use `ctx.destroy_entity`, `ctx.add_component`, `ctx.remove_component`; these buffer until the schedule flush, so archetype membership does not shift mid-`for_each`.

## Notes and pitfalls

- `Symbol.iterator` is not defined on `Query`. `for (const arch of q)` will not work; always use `q.for_each(...)`.
- `ChangedQuery.changed(def)` requires `def` to be in the base query's include mask — otherwise there is no column to track.
- `ctx.ref_mut` bumps the change tick at ref-creation time, not on assignment. Creating a mutable ref you never write to still marks the component changed for this archetype.
- `arch.get_column` is read-only; `arch.get_column_mut(def, field, ctx.world_tick)` is what triggers change detection for bulk writes.
- The non-empty archetype list is invalidated on structural changes only. Per-field writes do not invalidate it, so the same cached list is reused across `for_each` calls in the same frame.
- `q.archetype_count` includes empty archetypes; `q.count()` sums `entity_count` across all matching archetypes.
- Queries never expose entity IDs as a flat list — always iterate archetypes and read `arch.entity_ids`.
