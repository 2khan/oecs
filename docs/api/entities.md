# Entities

An entity in oecs is not an object — it's a lightweight **handle**. Each `EntityID` is a packed 31-bit integer encoding a slot **index** and a **generation** counter. Entities don't own storage; component data lives in typed-array columns grouped by archetype. The entity handle exists only to locate a row within some archetype.

## Exports

```ts
import type { EntityID } from "oecs";
```

`EntityID` is the only entity-related type exported from the public surface. Creation and destruction happen through `ECS` and `SystemContext` methods.

## Creating Entities

Create a new entity with `create_entity()`. It returns an `EntityID` immediately and places the entity in the empty archetype with no components attached.

```ts
const world = new ECS();
const e = world.create_entity();
world.add_component(e, Pos, { x: 0, y: 0 });
world.add_component(e, Vel, { vx: 1, vy: 2 });
```

From inside a system, use the `SystemContext`:

```ts
const spawner = world.register_system((ctx, _dt) => {
  const e = ctx.create_entity();
  ctx.add_component(e, Pos, { x: 0, y: 0 });
  ctx.add_component(e, IsEnemy);
});
```

There is no separate `spawn(...)` helper. To create an entity pre-populated with multiple components in a single archetype transition, use `add_components`:

```ts
const e = world.create_entity();
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: IsEnemy },
]);
```

This resolves the final archetype up front and moves the entity once, rather than once per component.

## Destroying Entities

Both destruction entry points are **deferred** — they buffer the entity for later removal rather than tearing down storage immediately.

From the `ECS` facade:

```ts
world.destroy_entity_deferred(e);
```

From a `SystemContext` (inside a system):

```ts
ctx.destroy_entity(e);
```

Deferral matters because systems are actively iterating archetype rows. Removing an entity mid-iteration would invalidate row indices and break the swap-remove loop. Buffered destructions run in batch at the end of each schedule phase.

Under the hood, both calls push into `pending_destroy`; the flush loop in `Store.flush_destroyed` swap-removes the entity from its archetype, bumps the slot's generation, and pushes the freed index onto the recycle stack.

## Liveness Checks

```ts
world.is_alive(e); // boolean
```

`is_alive` returns `true` when both of these hold:

1. The entity's index is below the high-water mark (`entity_high_water`).
2. The current generation stored at that slot equals the handle's generation.

Any handle whose slot has since been recycled (generation bumped) returns `false`. This is the only guarantee — it does **not** verify that the entity has any particular component or archetype membership beyond existence.

## EntityID Structure

`EntityID` is a branded `number`. Its bit layout is `[generation:11][index:20]`, packed into 31 bits so the sign bit stays clear:

| Field      | Bits | Max value      |
|------------|------|----------------|
| index      | 20   | 1,048,575      |
| generation | 11   | 2,047          |

```ts
// from src/entity.ts
create_entity_id(index, gen) => (gen << 20) | index
get_entity_index(id)         => id & 0xFFFFF
get_entity_generation(id)    => id >> 20
```

When an entity is destroyed, its slot's generation is incremented (`(gen + 1) & MAX_GENERATION`) and the index is pushed onto a free list. The next `create_entity()` call pops that index and pairs it with the new generation, producing a fresh `EntityID`.

This is what makes handles safe against reuse: an old, stale `EntityID` still points at the right slot, but the generation no longer matches, so `is_alive` returns `false`. No "dangling pointer" — just a provably-stale handle.

## Lifecycle Across Frames

The world tick is advanced once per `world.update(dt)` call. Within a tick, deferred changes flush **after each schedule phase** — the schedule calls `ctx.flush()` at the end of every phase run, which in turn runs:

```ts
// from src/query.ts — SystemContext.flush()
store.flush_structural();   // deferred add/remove component
store.flush_destroyed();    // deferred destroy
```

Structural changes flush **before** destructions within a single flush, so an entity that is both modified and destroyed in the same phase has its structural operations skipped by the stale-generation guard in the destroy flush (both flush loops re-check `ent_gens[idx] !== gen` and skip dead entities).

You can also call `world.flush()` manually outside the schedule — useful during setup or between manual system invocations.

Immediate (non-deferred) operations on the `ECS` facade — `create_entity`, `add_component`, `remove_component`, `add_components`, `remove_components`, `batch_add_component`, `batch_remove_component` — apply right away and do not go through the deferred buffers. Use these during setup or from code outside the schedule. Inside systems, prefer the `SystemContext` versions, which are all deferred.

## Pitfalls

**Storing an `EntityID` across frames without revalidating.** If code holds an `EntityID` in a resource, closure, or plain variable and uses it later without calling `is_alive`, and that entity has been destroyed and its slot recycled, reads and writes will silently target the new entity. In dev builds, `get_field`, `set_field`, `ref`, `ref_mut`, and `has_component` throw `ECS_ERROR.ENTITY_NOT_ALIVE` on stale handles; in production builds, the check is elided. Always gate long-lived handles:

```ts
if (world.is_alive(saved_id)) {
  const hp = world.get_field(saved_id, Health, "current");
}
```

**Assuming destruction is immediate.** After `destroy_entity_deferred(e)` (or `ctx.destroy_entity(e)`), the entity remains alive and fully indexed until the next flush. Queries running in the same phase will still see it. `is_alive(e)` returns `true` until the flush bumps the generation.

**Generation overflow.** Generations are 11 bits (max 2047). A slot that is created, destroyed, and recycled 2048 times will hit the overflow guard — in dev builds this throws `ECS_ERROR.EID_MAX_GEN_OVERFLOW`. In practice this is unreachable for normal workloads, but be aware if you churn a very small entity pool at high frequency.

**Index overflow.** The index field is 20 bits, capping a world at 1,048,575 concurrent entities. `create_entity_id` validates both bounds in dev builds.
