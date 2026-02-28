# Getting Started

This guide walks you through building a small simulation with OECS from scratch.

## Installation

```bash
pnpm add @oasys/oecs
```

## 1. Create a World

Everything starts with an `ECS` instance (the "world"). It owns all entities, components, systems, and state.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const world = new ECS();
```

You can pass options for fixed-timestep physics:

```ts
const world = new ECS({
  fixed_timestep: 1 / 50,  // 50 Hz physics (default: 1/60)
  max_fixed_steps: 4,       // cap iterations per frame to prevent spiral of death
});
```

## 2. Define Components

Components describe data that can be attached to entities. Each field maps to a typed array column for cache-friendly iteration.

```ts
// Record syntax — per-field type control
const Position = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });

// Array shorthand — all fields default to "f64"
const Velocity = world.register_component(["vx", "vy"] as const);

// Tags — no data, just a marker for queries
const IsEnemy = world.register_tag();
const IsPlayer = world.register_tag();
```

Supported typed array tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`.

> **Tip:** Use `as const` with array shorthand so TypeScript can infer exact field names.

## 3. Define Resources

Resources are global singletons — data that exists once and doesn't belong to any entity.

```ts
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0,
  elapsed: 0,
});

const GameState = world.register_resource(["score", "wave"] as const, {
  score: 0,
  wave: 1,
});
```

## 4. Define Events

Events are fire-and-forget messages that systems emit and read within the same frame. They are automatically cleared after each `world.update()`.

```ts
// Data events carry fields
const DamageEvent = world.register_event(["target", "amount"] as const);

// Signals carry no data — just a notification
const OnWaveComplete = world.register_signal();
```

## 5. Spawn Entities

Create entities and attach components to them.

```ts
// Spawn a player
const player = world.create_entity();
world.add_component(player, Position, { x: 400, y: 300 });
world.add_component(player, Velocity, { vx: 0, vy: 0 });
world.add_component(player, Health, { current: 100, max: 100 });
world.add_component(player, IsPlayer);

// Spawn an enemy — add_components does a single archetype transition instead of one per component
const enemy = world.create_entity();
world.add_components(enemy, [
  { def: Position, values: { x: 100, y: 100 } },
  { def: Velocity, values: { vx: 50, vy: 30 } },
  { def: Health, values: { current: 50, max: 50 } },
  { def: IsEnemy },
]);
```

## 6. Write Systems

Systems are plain functions. There are three registration styles.

### With a typed query (most common)

The query is resolved once at registration and reused every frame.

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
    for (const arch of q) {
      const px = arch.get_column(Position, "x");
      const py = arch.get_column(Position, "y");
      const vx = arch.get_column(Velocity, "vx");
      const vy = arch.get_column(Velocity, "vy");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    }
  },
  (qb) => qb.every(Position, Velocity),
);
```

### Without a query

For systems that only work with resources, events, or side effects.

```ts
const timeSys = world.register_system((ctx, dt) => {
  const time = ctx.resource(Time);
  ctx.set_resource(Time, {
    delta: dt,
    elapsed: time.elapsed + dt,
  });
});
```

### Full config (with lifecycle hooks)

```ts
const spawnSys = world.register_system({
  fn(ctx, dt) {
    // runs every frame
  },
  on_added(ctx) {
    // runs once during world.startup() — good for initial spawning
    const e = ctx.create_entity();
    ctx.add_component(e, Position, { x: 0, y: 0 });
  },
  dispose() {
    // runs during world.dispose() — good for cleanup
  },
});
```

## 7. Schedule Systems

Assign systems to lifecycle phases. Systems within a phase can declare ordering constraints.

```ts
world.add_systems(SCHEDULE.PRE_UPDATE, timeSys);
world.add_systems(SCHEDULE.UPDATE, moveSys);
world.add_systems(SCHEDULE.STARTUP, spawnSys);
```

### Schedule phases

| Phase | When | Typical use |
|---|---|---|
| `PRE_STARTUP` | Once, before startup | Resource loading |
| `STARTUP` | Once | Initial entity spawning |
| `POST_STARTUP` | Once, after startup | Validation |
| `FIXED_UPDATE` | Every tick (fixed dt) | Physics, simulation |
| `PRE_UPDATE` | Every frame, first | Input handling, time |
| `UPDATE` | Every frame | Game logic, AI |
| `POST_UPDATE` | Every frame, last | Rendering, cleanup |

### Ordering constraints

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, {
  system: physicsSys,
  ordering: { after: [moveSys] },  // physics runs after movement
});
```

## 8. Run the Loop

```ts
// Initialize — runs PRE_STARTUP → STARTUP → POST_STARTUP
world.startup();

// Game loop
function frame(timestamp: number) {
  const dt = /* compute delta time */;
  world.update(dt);  // runs FIXED_UPDATE (0+ times) → PRE_UPDATE → UPDATE → POST_UPDATE
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 9. Working Inside Systems

Systems receive a `SystemContext` (`ctx`) for entity manipulation and communication.

### Deferred structural changes

Structural changes (add/remove component, destroy entity) are buffered during system execution and applied after the phase completes. This prevents iterator invalidation.

```ts
const combatSys = world.register_system(
  (q, ctx, dt) => {
    for (const arch of q) {
      const entities = arch.entity_ids;
      const hp = arch.get_column(Health, "current");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        if (hp[i] <= 0) {
          ctx.destroy_entity(entities[i]);  // deferred — safe during iteration
        }
      }
    }
  },
  (qb) => qb.every(Health),
);
```

### Per-entity field access

```ts
// One-off read/write
const hp = ctx.get_field(entity, Health, "current");
ctx.set_field(entity, Health, "current", hp - 10);

// Cached ref — faster for repeated access to the same entity
const pos = ctx.ref(Position, entity);
const vel = ctx.ref(Velocity, entity);
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

### Events

```ts
// Emit
ctx.emit(DamageEvent, { target: entityId, amount: 25 });

// Read (in a later system within the same frame)
const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i];
  const amount = dmg.amount[i];
  // apply damage...
}
```

### Resources

```ts
const time = ctx.resource(Time);
console.log(time.delta, time.elapsed);

ctx.set_resource(GameState, { score: 100, wave: 2 });
```

## 10. Query Composition

Queries can be refined with chaining. Each method returns a new cached query.

```ts
// All entities with Position and Health, but not Dead
const alive = world.query(Position).and(Health).not(Dead);

// All entities with Health that have at least one status effect
const afflicted = world.query(Health).any_of(Poison, Fire, Curse);

// Combine all filters
const targets = world.query(Position)
  .and(Health)
  .not(Shield)
  .any_of(IsEnemy, IsBoss);
```

## Complete Example

A minimal game loop with movement, damage, and cleanup:

```ts
import { ECS, SCHEDULE, type EntityID } from "@oasys/oecs";

// --- World ---
const world = new ECS();

// --- Components ---
const Pos = world.register_component({ x: "f64", y: "f64" });
const Vel = world.register_component(["vx", "vy"] as const);
const Health = world.register_component({ current: "i32", max: "i32" });
const Dead = world.register_tag();

// --- Resources ---
const Time = world.register_resource(["delta", "elapsed"] as const, {
  delta: 0, elapsed: 0,
});

// --- Events ---
const Hit = world.register_event(["target", "damage"] as const);

// --- Systems ---
const timeSys = world.register_system((ctx, dt) => {
  const t = ctx.resource(Time);
  ctx.set_resource(Time, { delta: dt, elapsed: t.elapsed + dt });
});

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

// NOTE: This example is simplified — in a real game, targets from events
// may have been destroyed by another system. Guard with world.is_alive(target)
// before accessing fields. See Best Practices for details.
const damageSys = world.register_system((ctx, _dt) => {
  const hits = ctx.read(Hit);
  for (let i = 0; i < hits.length; i++) {
    const target = hits.target[i] as unknown as EntityID;
    const hp = ctx.get_field(target, Health, "current");
    ctx.set_field(target, Health, "current", hp - hits.damage[i]);
  }
});

const deathSys = world.register_system(
  (q, ctx, _dt) => {
    for (const arch of q) {
      const entities = arch.entity_ids;
      const hp = arch.get_column(Health, "current");
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        if (hp[i] <= 0) {
          ctx.add_component(entities[i], Dead);
        }
      }
    }
  },
  (qb) => qb.every(Health),
);

const cleanupSys = world.register_system(
  (q, ctx, _dt) => {
    for (const arch of q) {
      const entities = arch.entity_ids;
      const n = arch.entity_count;
      for (let i = 0; i < n; i++) {
        ctx.destroy_entity(entities[i]);
      }
    }
  },
  (qb) => qb.every(Dead),
);

// --- Schedule ---
world.add_systems(SCHEDULE.PRE_UPDATE, timeSys);
world.add_systems(SCHEDULE.UPDATE, moveSys, damageSys, {
  system: deathSys,
  ordering: { after: [damageSys] },
});
world.add_systems(SCHEDULE.POST_UPDATE, cleanupSys);

// --- Spawn ---
for (let i = 0; i < 1000; i++) {
  const e = world.create_entity();
  world.add_components(e, [
    { def: Pos, values: { x: Math.random() * 800, y: Math.random() * 600 } },
    { def: Vel, values: { vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100 } },
    { def: Health, values: { current: 100, max: 100 } },
  ]);
}

// --- Run ---
world.startup();

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  world.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## Next Steps

- [Components API](api/components.md) — schema types, phantom typing, multi-component operations
- [Queries API](api/queries.md) — chaining, caching, iteration patterns
- [Systems API](api/systems.md) — registration styles, SystemContext, lifecycle hooks
- [Events API](api/events.md) — data events, signals, lifecycle
- [Resources API](api/resources.md) — global singletons
- [Refs API](api/refs.md) — cached single-entity accessors
- [Schedule API](api/schedule.md) — phases, ordering, fixed timestep
- [Architecture](ARCHITECTURE.md) — internal design and data structures
- [Best Practices](BEST_PRACTICES.md) — performance tips and patterns
