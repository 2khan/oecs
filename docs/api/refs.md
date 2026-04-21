# Refs

A **ref** is a lightweight handle bound to one component on one entity within a system. Refs give you typed `ref.x`, `ref.y` field access that reads and writes directly into the archetype's SoA column arrays — no per-call field-name lookup, no repeated archetype/row resolution.

Refs exist so that code which naturally wants to talk about "a position" or "a velocity" as an object can still compile down to a single `columns[col_idx][row]` operation per field access. The archetype, the column group, and the row index are all resolved once at creation; subsequent reads and writes are direct indexed accesses on a typed array.

In v0.2.0 refs split into two forms:

- `ReadonlyComponentRef<S>` — field types are `readonly`, writes are a compile-time error.
- `ComponentRef<S>` — field types are mutable; writing through it also bumps the archetype's change tick for that component.

## Exports

From `oecs`:

```ts
import type { ComponentRef, ReadonlyComponentRef } from "oecs";
```

Both are type-only exports. Refs are created by methods on `SystemContext` (and `Query`, which forwards to the same factory) — there is no public constructor.

## `ctx.ref(def, entity)`

```ts
ref<S extends ComponentSchema>(
  def: ComponentDef<S>,
  entity_id: EntityID,
): ReadonlyComponentRef<S>
```

Returns a **read-only** ref to the component `def` on `entity_id`. The returned object has one `readonly` `number` property per field in `S`:

```ts
const pos = ctx.ref(Pos, e);
const dx = pos.x - pos.y;   // ok
pos.x = 0;                  // compile error: readonly
```

Reads are backed by `ReadonlyColumn` (`{ readonly [index: number]: number; readonly length: number }`), the same compile-time shape returned by `archetype.get_column`. No change tick is touched.

Use `ref()` when you only need to read fields. The readonly shape makes intent explicit and prevents accidental writes from propagating through change-detection queries.

## `ctx.ref_mut(def, entity)`

```ts
ref_mut<S extends ComponentSchema>(
  def: ComponentDef<S>,
  entity_id: EntityID,
): ComponentRef<S>
```

Returns a **mutable** ref. Each field in `S` is exposed as a writable `number` property:

```ts
const pos = ctx.ref_mut(Pos, e);
const vel = ctx.ref(Vel, e);
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

Calling `ref_mut` marks the component as changed for the current frame:

```ts
arch._changed_tick[def] = store._tick;
```

That write happens once, at ref creation — not on every field assignment. It is what `query.changed(def)` observes in later systems.

## Per-archetype rebinding

Inside `query.for_each((arch) => ...)`, you iterate archetypes, not entities. When you need to talk about an individual entity inside that loop, obtain the entity ID from `arch.entity_ids`, then call `ctx.ref` / `ctx.ref_mut` to build a handle for it. The same variable name can be reassigned per archetype and per entity:

```ts
q.for_each((arch) => {
  const eids = arch.entity_ids;
  for (let i = 0; i < arch.entity_count; i++) {
    const e = eids[i] as EntityID;
    const pos = ctx.ref_mut(Pos, e);
    const vel = ctx.ref(Vel, e);
    pos.x += vel.vx * dt;
    pos.y += vel.vy * dt;
  }
});
```

Ref creation is near-zero cost: the prototype with the field getters/setters is built **once per column group** and cached in a `WeakMap`. Creating a ref is `Object.create(proto)` plus two property writes (`_columns` and `_row`). Users never instantiate columns manually; that work is done inside `create_ref` by reading `archetype.column_groups[cid]` and snapshotting each column's underlying typed array `buf`.

For hot inner loops over large archetypes, direct column iteration via `arch.get_column` / `arch.get_column_mut` is still the fastest shape. Refs are the right tool when you want ergonomic access to a small number of entities, or when you want the field-dot syntax without giving up SoA performance.

## When to use `ref` vs `ref_mut`

Both have equivalent per-access cost — the getter path is identical, and `ref_mut` pays only one additional write at creation time to bump `_changed_tick`. Choose based on intent:

| You want to                  | Use                 |
|------------------------------|---------------------|
| Read fields only             | `ctx.ref(def, e)`   |
| Write any field              | `ctx.ref_mut(def, e)` |
| Make read-only intent explicit at the type level | `ctx.ref(def, e)` |

If a system only reads `Pos`, using `ref` (not `ref_mut`) keeps `Pos`'s change tick untouched, so downstream `query.changed(Pos)` systems stay correct. Prefer `ref` by default and reach for `ref_mut` at the point of actual mutation.

## Under the hood

Both factories resolve the same way:

1. `store.get_entity_archetype(entity_id)` → `Archetype`
2. `store.get_entity_row(entity_id)` → `number`
3. `arch.column_groups[def]` → `{ layout, columns }`
4. `create_ref(group, row)`:
   - Look up or build the prototype for `group` (cached in a module-level `WeakMap`).
   - The prototype defines one getter/setter pair per `layout.field_names[i]`, each bound to a fixed `col_idx`.
   - Allocate the instance with `Object.create(proto)`, snapshot every column's `.buf` into an array, store it on `_columns`, store `row` on `_row`.

Every field read compiles to `this._columns[col_idx][this._row]`; every write compiles to `this._columns[col_idx][this._row] = v`. The change tick for `ref_mut` comes from `ctx.store._tick`, which is the current frame's world tick — the same tick passed to `archetype.get_column_mut` by system code using columns directly. Both paths write into the same `arch._changed_tick[cid]` slot, so change detection is consistent whether you use refs or columns.

Developer-mode (`__DEV__`) checks verify `store.is_alive(entity_id)` before construction; in production builds this check is stripped.

## Pitfalls

**Do not hold a ref across an archetype transition.** A ref captures `_columns` (typed array buffers) and `_row` at creation. Any operation that moves the entity into a different archetype — `ctx.add_component`, `ctx.remove_component`, or a `ctx.flush()` that applies buffered structural changes — invalidates those captures. The ref will still read and write memory, but the memory now belongs to a different entity (or none at all). Rebind by calling `ctx.ref` / `ctx.ref_mut` again after the flush.

**Do not use a ref after `for_each` exits.** While structural changes inside a system are deferred (so refs are stable for the duration of the system's work), the phase flush that follows may reshuffle rows via swap-and-pop. A ref obtained inside `for_each` is only valid until the next flush boundary.

**Empty archetypes.** `for_each` already skips archetypes where `entity_count === 0`, so code inside the callback can safely iterate `0..entity_count`. If you obtain entity IDs outside of a query (e.g., from an event payload) and call `ctx.ref`, the dev-mode alive check will catch destroyed entities; in production, passing a dead entity ID is undefined behavior.

**Tag components.** Refs require a column group. A component registered as a tag (empty schema) has no columns — `ctx.ref(Tag, e)` will fail to construct. Tags participate in archetype matching only.
