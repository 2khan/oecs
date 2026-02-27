# Components

## Registering Components

`register_component` defines a data component. Pass a `readonly` tuple of field names. All field values are `number`.

```ts
const Pos = world.register_component(["x", "y"] as const);
const Vel = world.register_component(["vx", "vy"] as const);
const Health = world.register_component(["current", "max"] as const);
```

`as const` is required -- without it TypeScript widens the type to `string[]` and field-level type inference is lost.

The return type is `ComponentDef<F>` where `F` is the field tuple (e.g. `ComponentDef<readonly ["x", "y"]>`).

## Tags

Tags are components with no fields. They participate in archetype matching and queries but store no data.

```ts
const IsEnemy = world.register_tag();
const Frozen = world.register_tag();
```

Return type: `ComponentDef<readonly []>`.

Internally, tag-only archetypes skip all column operations (push, pop, copy, swap) during entity transitions -- only the entity ID list is maintained.

## Adding Components

Data components require a values object:

```ts
const e = world.create_entity();
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Vel, { vx: 1, vy: -1 });
```

Tags take no values argument:

```ts
world.add_component(e, IsEnemy);
```

If the entity already has the component, values are overwritten in-place with no archetype transition:

```ts
world.add_component(e, Pos, { x: 10, y: 20 });
world.add_component(e, Pos, { x: 99, y: 0 }); // overwrites, no transition
```

## Batch Add

`add_components` resolves the final archetype first, then performs a single entity move instead of intermediate transitions per component.

```ts
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: IsEnemy },
]);
```

This is cheaper than three separate `add_component` calls when the entity needs multiple new components at once.

## Removing Components

Single removal:

```ts
world.remove_component(e, Vel);
```

`remove_component` returns `this`, so calls can be chained:

```ts
world.remove_component(e, Vel).remove_component(e, Frozen);
```

Batch removal avoids intermediate archetype transitions:

```ts
world.remove_components(e, Pos, Vel, IsEnemy);
```

Removing a component the entity does not have is a no-op.

## Checking Components

```ts
if (world.has_component(e, Pos)) {
  // entity has the Pos component
}

world.has_component(e, IsEnemy); // works for tags too
```

Returns `boolean`.

## Phantom Typing

`ComponentDef<F>` is a branded `number` at runtime (specifically a `ComponentID`). The generic parameter `F` exists only at compile time via a phantom symbol:

```ts
declare const __schema: unique symbol;
type ComponentDef<F extends ComponentFields> = ComponentID & {
  readonly [__schema]: F;
};
```

At runtime `Pos` is just a number (the component's internal ID). At compile time it carries `readonly ["x", "y"]`, which flows through the entire API:

- `add_component(e, Pos, ...)` requires `{ x: number, y: number }` -- missing or extra fields are compile errors.
- `query.each((pos, vel, n) => ...)` infers `pos` as `{ readonly x: number[], readonly y: number[] }`.
- `archetype.get_column(Pos, "x")` accepts only `"x" | "y"` for the field argument.

This gives full type safety with zero runtime overhead -- no wrapper objects, no maps, just a plain integer ID.
