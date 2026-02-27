# Best Practices

Performance tips, common patterns, and pitfalls for building with OECS.

## Iteration

### Use batch column iteration, not per-entity access

The SoA layout is designed for tight inner loops over typed array columns. This is the fastest way to process entities.

```ts
// GOOD — batch column iteration
const moveSys = world.register_system(
  (q, _ctx, dt) => {
    for (const arch of q) {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    }
  },
  (qb) => qb.every(Pos, Vel),
);

// BAD — per-entity field access in a loop (lookups archetype + row each call)
const moveSys = world.register_system(
  (q, ctx, dt) => {
    for (const arch of q) {
      const entities = arch.entity_ids;
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        const x = ctx.get_field(entities[i], Pos, "x");
        ctx.set_field(entities[i], Pos, "x", x + ctx.get_field(entities[i], Vel, "vx") * dt);
        // ... much slower
      }
    }
  },
  (qb) => qb.every(Pos, Vel),
);
```

### Hoist column lookups outside the inner loop

`get_column()` does a sparse array lookup. Call it once per archetype, not per entity.

```ts
// GOOD
for (const arch of q) {
  const px = arch.get_column(Pos, "x");   // once per archetype
  for (let i = 0; i < arch.entity_count; i++) {
    px[i] += 1;
  }
}

// BAD
for (const arch of q) {
  for (let i = 0; i < arch.entity_count; i++) {
    arch.get_column(Pos, "x")[i] += 1;    // lookup every iteration
  }
}
```

### Cache `entity_count` in a local

Avoids repeated property access in the loop condition.

```ts
for (const arch of q) {
  const n = arch.entity_count;
  const px = arch.get_column(Pos, "x");
  for (let i = 0; i < n; i++) {
    px[i] += 1;
  }
}
```

## Refs

### Use refs for single-entity access, not batch iteration

Refs are ideal when you need to read/write multiple fields on a specific entity (e.g., a player, a boss). They are significantly faster than `get_field`/`set_field` for repeated access to the same entity.

```ts
// GOOD — ref for per-entity work
const pos = ctx.ref(Pos, player);
const vel = ctx.ref(Vel, player);
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

Do not use refs for batch iteration — column access is faster.

### Do not hold refs across flush boundaries

Refs cache the archetype row and column pointers. If `ctx.flush()` is called (manually or between phases), the entity may have moved to a different archetype, invalidating the ref.

```ts
const pos = ctx.ref(Pos, entity);
pos.x = 10;              // safe
ctx.flush();              // structural changes applied
// pos is now stale — do not use it
```

## Component Design

### Choose the right typed array tag

Use the narrowest type that fits your data. Narrower types mean denser memory and better cache utilization.

| Data | Tag | Range |
|------|-----|-------|
| Positions, velocities, physics | `"f64"` | Full double precision |
| Pixel coordinates, health | `"f32"` or `"i32"` | 32-bit |
| Tile indices, small counts | `"i16"` or `"u16"` | -32768..32767 or 0..65535 |
| Flags, small enums | `"u8"` or `"i8"` | 0..255 or -128..127 |

```ts
// Precise physics
const Pos = world.register_component({ x: "f64", y: "f64" });

// Integer health
const Health = world.register_component({ current: "i32", max: "i32" });

// Compact tile data
const Tile = world.register_component({ type: "u8", variant: "u8" });
```

### Use tags for marker components

Tags have no data columns. Tag-only archetypes skip all column operations during entity transitions, making them very cheap.

```ts
const IsEnemy = world.register_tag();
const IsPlayer = world.register_tag();
const Frozen = world.register_tag();
const Dead = world.register_tag();
```

Tags are perfect for filtering queries:

```ts
const enemies = world.query(Pos, Health).and(IsEnemy);
const alive = world.query(Health).not(Dead);
```

### Prefer `add_components` for multiple components

When adding several components to a new entity, use `add_components` to perform a single archetype transition instead of multiple intermediate ones.

```ts
// GOOD — single transition
world.add_components(entity, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 2 } },
  { def: Health, values: { current: 100, max: 100 } },
  { def: IsEnemy },
]);

// SLOWER — 4 separate transitions
world.add_component(entity, Pos, { x: 0, y: 0 });
world.add_component(entity, Vel, { vx: 1, vy: 2 });
world.add_component(entity, Health, { current: 100, max: 100 });
world.add_component(entity, IsEnemy);
```

### Use `batch_add_component` / `batch_remove_component` for whole-archetype changes

When you need to add or remove a component from every entity matching a query, `batch_add_component` and `batch_remove_component` do it in one bulk copy instead of per-entity transitions.

```ts
// Add a Burning tag to every entity with Health — one bulk move per archetype
for (const arch of world.query(Health)) {
  world.batch_add_component(arch, Burning);
}

// Remove Shield from all enemies — one bulk move per archetype
for (const arch of world.query(IsEnemy, Shield)) {
  world.batch_remove_component(arch, Shield);
}
```

This is O(columns) per archetype via `TypedArray.set()`, compared to O(N×columns) when calling `add_component` per entity. Use it for wave spawns, status effect sweeps, or any operation that applies uniformly across all entities in a query.

## Systems

### Keep systems small and focused

Each system should do one thing. This makes ordering easier to reason about and lets you schedule systems independently.

```ts
// GOOD — separate concerns
const moveSys = world.register_system(/* movement */);
const damageSys = world.register_system(/* damage application */);
const deathSys = world.register_system(/* death detection */);

// BAD — monolithic system
const everythingSys = world.register_system(/* movement + damage + death + rendering */);
```

### Use the query-builder overload for systems with queries

This resolves the query once at registration time and captures it in the closure. No repeated query resolution per frame.

```ts
// GOOD — query resolved once
world.register_system(
  (q, ctx, dt) => { for (const arch of q) { /* ... */ } },
  (qb) => qb.every(Pos, Vel),
);
```

### Understand deferred vs immediate operations

| Context | `add_component` | `remove_component` | `destroy_entity` |
|---------|----------------|-------------------|-----------------|
| On `world` (ECS) | Immediate | Immediate | Deferred (`destroy_entity_deferred`) |
| On `ctx` (SystemContext) | Deferred | Deferred | Deferred |

Inside systems, all structural changes through `ctx` are deferred until the phase flush. This is by design — it prevents iterator invalidation. If you need changes to take effect mid-system, call `ctx.flush()` explicitly, but be aware this invalidates any refs you're holding.

### Use ordering constraints instead of phase splitting

If system A must run before system B, use ordering constraints within the same phase rather than putting them in different phases.

```ts
// GOOD — explicit ordering within a phase
world.add_systems(SCHEDULE.UPDATE, moveSys, {
  system: collisionSys,
  ordering: { after: [moveSys] },
});

// AVOID — using phases as ordering mechanism
world.add_systems(SCHEDULE.PRE_UPDATE, moveSys);
world.add_systems(SCHEDULE.UPDATE, collisionSys);
```

Phases serve a semantic purpose (startup vs update vs fixed update). Use ordering for sequencing within a phase.

## Events

### Events are single-frame — read them the same frame they are emitted

Events are auto-cleared at the end of `world.update()`. Systems that need to react to an event must be scheduled in the same or a later phase within the same frame.

```ts
// Phase: UPDATE — emit
ctx.emit(Damage, { target: e, amount: 50 });

// Phase: UPDATE or POST_UPDATE — read (same frame)
const dmg = ctx.read(Damage);
for (let i = 0; i < dmg.length; i++) { /* ... */ }

// Next frame — events are gone
```

### Use signals for notifications without data

Signals are ~14x faster than data events because they only increment a counter.

```ts
const OnPause = world.register_signal();

// Emit
ctx.emit(OnPause);

// Check
if (ctx.read(OnPause).length > 0) {
  // game was paused this frame
}
```

## Resources

### Use resources for global state, not components

Resources are for data that exists once globally: time, input, config, camera. Don't create a single entity with "global" components.

```ts
// GOOD — resource
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0, elapsed: 0,
});
const t = ctx.resource(Time);

// BAD — entity used as a singleton
const timeEntity = world.create_entity();
world.add_component(timeEntity, TimeComponent, { delta: 0, elapsed: 0 });
```

### Resource writes are immediate

Unlike component operations through `ctx`, resource writes take effect immediately. All subsequent systems in the same frame see the updated values.

## Queries

### Queries are cached and live — don't recreate them

`world.query()` returns a cached, live view. The same mask combination always returns the same instance. As new archetypes are created, matching ones are automatically added.

```ts
// These return the same cached instance
const q1 = world.query(Pos, Vel);
const q2 = world.query(Pos, Vel);
// q1 === q2

// Use the query-builder in register_system for system-owned queries
```

### Avoid over-fragmenting with queries

Every unique component combination creates a new archetype. A query scans all matching archetypes. If you have many archetypes with few entities each, iteration overhead increases.

```ts
// This creates many archetypes if entities have different tag combinations
const HasFire = world.register_tag();
const HasIce = world.register_tag();
const HasPoison = world.register_tag();
// 2^3 = 8 possible archetypes just from these 3 tags

// Consider: if you always iterate all status effects together,
// a single component with flag fields may be better
const Status = world.register_component({ fire: "u8", ice: "u8", poison: "u8" });
```

This is a tradeoff. Tags are cheap to add/remove and enable precise queries. Packed fields are fewer archetypes but lose query-level filtering. Choose based on your access patterns.

## Fixed Timestep

### Use FIXED_UPDATE for deterministic simulation

Physics, collision detection, and simulation logic should go in `FIXED_UPDATE`. It runs at a constant rate regardless of frame rate.

```ts
world.add_systems(SCHEDULE.FIXED_UPDATE, physicsSys, collisionSys);
```

### Use `fixed_alpha` for rendering interpolation

The fixed timestep accumulator leaves a remainder each frame. Use `world.fixed_alpha` to interpolate between the previous and current fixed-step state for smooth rendering.

```ts
const renderSys = world.register_system(
  (q, ctx, _dt) => {
    const alpha = world.fixed_alpha;
    for (const arch of q) {
      const px = arch.get_column(Pos, "x");
      const prevX = arch.get_column(PrevPos, "x");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        const rendered_x = prevX[i] + (px[i] - prevX[i]) * alpha;
        // draw at rendered_x
      }
    }
  },
  (qb) => qb.every(Pos, PrevPos),
);
```

## Cleanup

### Always call `world.dispose()` when done

This calls `dispose()` and `on_removed()` on all registered systems, allowing them to clean up external resources (WebGL contexts, audio, timers).

```ts
world.dispose();
```

## Common Pitfalls

### Mutating column arrays beyond `entity_count`

Typed arrays returned by `get_column()` may be larger than the number of entities (due to growable backing buffers). Always loop up to `arch.entity_count`, not the array's `.length`.

```ts
// GOOD
for (let i = 0; i < arch.entity_count; i++) { ... }

// BUG — processes stale data beyond entity_count
for (let i = 0; i < px.length; i++) { ... }
```

### Forgetting `as const` on array shorthand

Without `as const`, TypeScript widens the type to `string[]` and you lose field-level type inference.

```ts
// GOOD — exact field names inferred
const Vel = world.register_component(["vx", "vy"] as const);

// BAD — fields typed as string, no autocomplete
const Vel = world.register_component(["vx", "vy"]);
```

### Holding entity IDs after destruction

Entity IDs are generational. After an entity is destroyed, its slot may be reused with a new generation. A stale ID will be detected as dead by `world.is_alive()`, but if the generation wraps around (after 2047 reuses of the same slot), a stale ID could theoretically alias a new entity. In practice, this is extremely unlikely.

### Circular system dependencies

Ordering constraints that form a cycle will throw at runtime (always — this check is not tree-shaken in production). Design your system ordering as a DAG.

```ts
// This will throw
world.add_systems(SCHEDULE.UPDATE,
  { system: a, ordering: { after: [b] } },
  { system: b, ordering: { after: [a] } },
);
```
