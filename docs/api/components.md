# Components

A component is a named record of numeric fields attached to entities. Storage is Struct-of-Arrays: each field lives in its own typed array column, grouped by archetype (the exact set of components an entity has). Entities with identical component sets share one archetype and therefore share contiguous column buffers, which is what queries iterate over. At runtime, a component is just a branded integer ID — the field schema is carried as a phantom type parameter for compile-time safety only.

## Exports

From `oecs`:

```ts
import {
  type ComponentDef,
  type ComponentSchema,
  type ComponentFields,
  type FieldValues,
  type TagToTypedArray,
  type ColumnsForSchema,
  type ReadonlyColumn,
  type ReadonlyUint32Array,
} from "oecs";
```

All component registration and per-entity operations are methods on the `ECS` world instance (`import { ECS } from "oecs"`).

## Registering components

### Record syntax (per-field type control)

Pass a record mapping field names to typed array tags. Each field's column uses the specified typed array type.

```ts
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });
```

The returned value is typed as `ComponentDef<S>` where `S` is the schema record (e.g. `ComponentDef<{ x: "f64", y: "f64" }>`).

Supported tags (see `TagToTypedArray`):

| Tag   | Typed array    |
| ----- | -------------- |
| `f32` | `Float32Array` |
| `f64` | `Float64Array` |
| `i8`  | `Int8Array`    |
| `i16` | `Int16Array`   |
| `i32` | `Int32Array`   |
| `u8`  | `Uint8Array`   |
| `u16` | `Uint16Array`  |
| `u32` | `Uint32Array`  |

### Array shorthand (uniform type)

Pass a `readonly` tuple of field names. All fields default to `"f64"`; an optional second argument overrides the type for every field.

```ts
const Vel = world.register_component(["vx", "vy"] as const);        // all f64
const Flags = world.register_component(["a", "b"] as const, "u8");  // all u8
```

`as const` is required — without it TypeScript widens to `string[]` and per-field inference is lost.

The exact signatures:

```ts
register_component<S extends Record<string, TypedArrayTag>>(schema: S): ComponentDef<S>;
register_component<const F extends readonly string[], T extends TypedArrayTag = "f64">(
  fields: F,
  type?: T,
): ComponentDef<{ readonly [K in F[number]]: T }>;
```

## Tags (zero-field components)

Tags are components with an empty schema. They participate in archetype matching and queries but store no data.

```ts
const IsEnemy = world.register_tag();
const Frozen = world.register_tag();
```

The return type is `ComponentDef<Record<string, never>>`. Tag-only archetypes skip all column operations during entity transitions — only the entity ID list is maintained.

## Adding components

Data components require a values object whose shape matches the schema:

```ts
const e = world.create_entity();
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Vel, { vx: 1, vy: -1 });
```

Tags take no values argument:

```ts
world.add_component(e, IsEnemy);
```

If the entity already has the component, the existing values are overwritten in place with no archetype transition:

```ts
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Pos, { x: 99, y: 0 }); // overwrite, no transition
```

`add_component` returns `this` so calls can be chained:

```ts
world
  .add_component(e, Pos, { x: 0, y: 0 })
  .add_component(e, Vel, { vx: 1, vy: 2 })
  .add_component(e, IsEnemy);
```

### Adding several components at once

`add_components` walks the archetype graph through all adds, resolves the final target archetype, and performs a single entity move instead of one move per component.

```ts
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: IsEnemy },
]);
```

## Removing components

Single removal:

```ts
world.remove_component(e, Vel);
```

`remove_component` returns `this`, so calls can be chained. Removing a component the entity does not have is a no-op.

`remove_components` coalesces multiple removals into a single transition:

```ts
world.remove_components(e, Pos, Vel, IsEnemy);
```

## Checking for a component

```ts
if (world.has_component(e, Pos)) {
  // ...
}

world.has_component(e, IsEnemy); // works for tags too
```

Returns `boolean`.

## Reading and writing a single field

For random-access single-entity reads and writes, the world exposes `get_field` and `set_field`:

```ts
get_field<S>(entity_id: EntityID, def: ComponentDef<S>, field: string & keyof S): number;
set_field<S>(entity_id: EntityID, def: ComponentDef<S>, field: string & keyof S, value: number): void;
```

```ts
const hp = world.get_field(e, Health, "current");
world.set_field(e, Health, "current", hp - 10);
```

`set_field` marks the component's column as changed at the current world tick, so change-detection queries see the write. For bulk hot-loop mutation inside a system, prefer `arch.get_column_mut(def, field, tick)` over many `set_field` calls.

## `ComponentDef<S>` and phantom typing

At runtime, `ComponentDef<S>` is just a branded integer (`ComponentID`). The generic parameter `S extends ComponentSchema` exists only at compile time via a phantom symbol:

```ts
declare const __schema: unique symbol;

export type ComponentDef<S extends ComponentSchema = ComponentSchema> = ComponentID & {
  readonly [__schema]: S;
};

export type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;
```

Because `S` flows through the type system:

- `add_component(e, Pos, ...)` requires `{ x: number, y: number }`. Missing or extra fields are compile errors.
- `get_field(e, Pos, "x")` only accepts `"x" | "y"` for the field argument.
- `arch.get_column(Pos, "x")` accepts only `"x" | "y"`; `arch.get_column_mut(Pos, "x", tick)` is typed as `Float64Array`, while `get_column_mut(Health, "current", tick)` is typed as `Int32Array` — the return is derived from `S` via `TagToTypedArray`.

No wrapper objects, no maps — the ID is a plain integer and all the richness is compile-time only.

Related helper types:

```ts
// Per-field value object used by add_component / add_components:
type FieldValues<S extends ComponentSchema> = { readonly [K in keyof S]: number };

// Per-field column map (typed array per field):
type ColumnsForSchema<S extends ComponentSchema> = {
  readonly [K in keyof S]: TagToTypedArray[S[K]];
};
```

## `ReadonlyColumn` and `ReadonlyUint32Array` (new in v0.2.0)

To make accidental writes to column buffers a compile-time error, archetype read accessors return structural read-only views rather than bare typed arrays:

```ts
export interface ReadonlyColumn {
  readonly [index: number]: number;
  readonly length: number;
}

export interface ReadonlyUint32Array {
  readonly [index: number]: number;
  readonly length: number;
}
```

These are used by:

- `Archetype.get_column(def, field)` — returns `ReadonlyColumn`. Reads only; attempting `col[i] = v` is a type error.
- `Archetype.entity_ids` — returns `ReadonlyUint32Array`.

To mutate a column, use `get_column_mut`, which takes a tick and returns the concrete typed array:

```ts
// Read-only iteration
q.for_each((arch) => {
  const px = arch.get_column(Pos, "x");      // ReadonlyColumn
  const py = arch.get_column(Pos, "y");      // ReadonlyColumn
  for (let i = 0; i < arch.entity_count; i++) {
    doSomething(px[i], py[i]);
  }
});

// Mutation
q.for_each((arch) => {
  const px = arch.get_column_mut(Pos, "x", ctx.world_tick); // Float64Array
  for (let i = 0; i < arch.entity_count; i++) px[i] += 1;
});
```

At runtime both methods return the same underlying typed array — the distinction is purely in the TypeScript types.

## Notes

### Archetype transitions

Every `add_component` / `remove_component` that changes the entity's component set moves the entity from its source archetype to a target archetype: its row is copied into the target, and the source row is swap-removed. The add/remove edges between archetypes are cached on first use, so repeated transitions (e.g. "add `Vel` to `[Pos]`") resolve in O(1) thereafter. Re-adding a component the entity already has, or removing one it does not have, does not transition.

### Write change detection

`set_field` and `get_column_mut` stamp the component's per-archetype change tick with the current world tick. Plain reads via `get_field` and `get_column` do not. This is what the `ChangedQuery` API keys on — see [change-detection.md](./change-detection.md) for details.
