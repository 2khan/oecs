# Getting Started

oecs is an archetype-based TypeScript ECS. Components are typed-array columns grouped by archetype; systems are plain functions scheduled across lifecycle phases. This guide builds a small simulation end-to-end — components, resources, events, systems, scheduling, and change detection.

## 1. Install

```bash
pnpm add @oasys/oecs
```

## 2. Create a World

The `ECS` class (the "world") is the single entry point. It owns every entity, component, system, resource, and event channel.

```ts
import { ECS, SCHEDULE } from "@oasys/oecs";

const world = new ECS({
  fixed_timestep: 1 / 60,   // FIXED_UPDATE rate (default 1/60)
  max_fixed_steps: 4,       // cap fixed steps per update() to avoid spiral of death
  initial_capacity: 1024,   // per-archetype initial column capacity
});
```

All options are optional — `new ECS()` uses sensible defaults.

## 3. Define Components

Each field maps to a dedicated typed-array column for cache-friendly iteration.

```ts
// Record syntax — per-field type control
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });

// Array shorthand — uniform type, defaults to "f64"
const Vel = world.register_component(["vx", "vy"] as const);

// Override the uniform type
const Flags = world.register_component(["a", "b"] as const, "u8");

// Tag — empty schema, participates in queries but stores no data
const IsEnemy = world.register_tag();
const Dead = world.register_tag();
```

Supported tags: `"f32"`, `"f64"`, `"i8"`, `"i16"`, `"i32"`, `"u8"`, `"u16"`, `"u32"`. `as const` on the array shorthand is required — without it TypeScript widens to `string[]` and per-field types are lost.

## 4. Define Resources

Resources are world-scoped singletons — time, input, configs, asset tables. Values can be any type: plain objects, `Map`, typed arrays, class instances. Keys are defined at module scope with `resource_key<T>(name)` and registered once on the world.

```ts
import { resource_key } from "@oasys/oecs";

const Time = resource_key<{ delta: number; elapsed: number }>("Time");
const Score = resource_key<{ value: number }>("Score");

world.register_resource(Time, { delta: 0, elapsed: 0 });
world.register_resource(Score, { value: 0 });

const time = world.resource(Time);           // { delta: number; elapsed: number }
world.set_resource(Score, { value: 100 });
world.has_resource(Time);                    // true
```

`register_resource` returns `void` — the key is the handle. Each key must be registered exactly once.

## 5. Define Events and Signals

Events are fire-and-forget messages that systems emit within a frame and other systems read in the same frame; they clear automatically at the end of every `world.update(dt)`. Use `event_key<F>(name)` for data events and `signal_key(name)` for zero-field signals, then register each key once.

```ts
import { event_key, signal_key } from "@oasys/oecs";

const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");
world.register_event(DamageEvent, ["target", "amount"] as const);

const GameOver = signal_key("GameOver");
world.register_signal(GameOver);

world.emit(DamageEvent, { target: 42, amount: 10 });
world.emit(GameOver);

const dmg = world.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const t = dmg.target[i];
  const a = dmg.amount[i];
}
```

Inside systems, use `ctx.emit` / `ctx.read` (section 10). Event field values are numbers only — for richer payloads, store them on a sentinel entity and reference it by ID.

## 6. Spawn Entities

```ts
const player = world.create_entity();
world.add_component(player, Pos, { x: 400, y: 300 });
world.add_component(player, Health, { current: 100, max: 100 });

// add_components walks the archetype graph once — cheaper when spawning
const enemy = world.create_entity();
world.add_components(enemy, [
  { def: Pos, values: { x: 100, y: 100 } },
  { def: Vel, values: { vx: 50, vy: 30 } },
  { def: Health, values: { current: 50, max: 50 } },
  { def: IsEnemy },
]);
```

Remove with `remove_component` / `remove_components`, check with `has_component`, destroy via `world.destroy_entity_deferred(e)` (or `ctx.destroy_entity(e)` from a system).

## 7. Write Systems

Systems are plain functions. `register_system` has three forms and always returns a `SystemDescriptor`.

### With a query (most common)

The query is resolved once at registration. Use `qb.every(...)` to specify required components.

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
      const py = arch.get_column_mut(Pos, "y", ctx.world_tick);
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      for (let i = 0; i < arch.entity_count; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    });
  },
  (qb) => qb.every(Pos, Vel),
);
```

- `q.for_each((arch) => ...)` iterates non-empty archetypes. `for (const arch of q)` does **not** work.
- `arch.get_column(def, field)` returns `ReadonlyColumn` (read-only at compile time).
- `arch.get_column_mut(def, field, tick)` returns a writable typed array and stamps the archetype's change tick; pass `ctx.world_tick`.

### Bare function (no query)

For systems that only touch resources, events, or side effects.

```ts
const tickTime = world.register_system((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});
```

### Full config (lifecycle hooks)

```ts
const spawner = world.register_system({
  name: "spawner",
  fn(ctx, _dt) { /* every frame */ },
  on_added(ctx) {           // once, during world.startup()
    const e = ctx.create_entity();
    ctx.add_component(e, Pos, { x: 0, y: 0 });
  },
  on_removed() { /* world.remove_system(...) */ },
  dispose()    { /* world.dispose() */ },
});
```

## 8. Schedule Systems

Assign systems to phases. Phases run in a fixed order; within a phase you can declare ordering constraints.

```ts
world.add_systems(SCHEDULE.STARTUP, spawner);
world.add_systems(SCHEDULE.PRE_UPDATE, tickTime);
world.add_systems(SCHEDULE.UPDATE, moveSys);
```

| Phase           | Runs in           | When                                         |
| --------------- | ----------------- | -------------------------------------------- |
| `PRE_STARTUP`   | `world.startup()` | Once, before `STARTUP`                       |
| `STARTUP`       | `world.startup()` | Once                                         |
| `POST_STARTUP`  | `world.startup()` | Once, after `STARTUP`                        |
| `FIXED_UPDATE`  | `world.update()`  | Zero or more times at `fixed_timestep`       |
| `PRE_UPDATE`    | `world.update()`  | Every frame, first                           |
| `UPDATE`        | `world.update()`  | Every frame                                  |
| `POST_UPDATE`   | `world.update()`  | Every frame, last                            |

After each phase, `ctx.flush()` runs automatically so the next phase sees a consistent store.

### Ordering

Pass a `SystemEntry` with `before` / `after` arrays of `SystemDescriptor`.

```ts
world.add_systems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: physicsSys, ordering: { after: [moveSys] } },
  { system: renderSys,  ordering: { after: [physicsSys] } },
);
```

A cycle inside a phase throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` on the first run. Ordering applies only within the same phase — use different labels to sequence across phases.

## 9. Run the Loop

```ts
world.startup();           // PRE_STARTUP → STARTUP → POST_STARTUP, once

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  world.update(dt);        // FIXED_UPDATE (0+) → PRE_UPDATE → UPDATE → POST_UPDATE
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## 10. Working Inside Systems

Every system receives a shared `SystemContext` (`ctx`) with deferred structural operations, per-entity accessors, events, resources, and change-detection ticks.

### Deferred structural changes

Structural operations inside a system buffer until the phase flush, keeping iterators valid. A deferred destruction inside `for_each` is safe — the entity stays visible in the current iteration and is removed at the flush.

```ts
ctx.create_entity();                   // immediate (new entity, no components)
ctx.add_component(e, Pos, { x, y });   // deferred
ctx.remove_component(e, Vel);          // deferred
ctx.destroy_entity(e);                 // deferred
```

### `ref` vs `ref_mut`

Use `ctx.ref` / `ctx.ref_mut` for dot-syntax access to a single entity's fields.

```ts
const pos = ctx.ref(Pos, entity);       // ReadonlyComponentRef — reads only
const vel = ctx.ref_mut(Vel, entity);   // ComponentRef — writable, stamps change tick
vel.vx += 1;
```

`ctx.ref` does not touch the change tick. `ctx.ref_mut` stamps `_changed_tick[def] = world_tick` at creation, regardless of whether you write through it — reach for it only at the point of mutation. Refs are valid until the next phase flush; do not hold one across `ctx.flush()` or a structural change that moves the entity between archetypes.

### Events and resources

```ts
ctx.emit(DamageEvent, { target: id, amount: 25 });
ctx.emit(GameOver);

const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i];
  const amount = dmg.amount[i];
}

const t = ctx.resource(Time);            // live reference, mutate in place
t.delta = dt;
t.elapsed += dt;
ctx.set_resource(Score, { value: 0 });   // or replace the whole value
```

Readers are zero-copy views — iterate up to `reader.length`, do not slice.

### Change detection

Two `SystemContext` fields:

- `ctx.world_tick` — current world tick; pass as the `tick` argument to `arch.get_column_mut`.
- `ctx.last_run_tick` — the tick this system's most recent dispatch started (0 on first run).

`q.changed(...defs)` iterates only archetypes where one of the listed components was written at or after `ctx.last_run_tick`:

```ts
const detector = world.register_system(
  (q, _ctx, _dt) => {
    q.changed(Pos).for_each((arch) => {
      // Only archetypes whose Pos column was stamped since this system last ran.
    });
  },
  (qb) => qb.every(Pos),
);
```

Every component passed to `.changed(...)` must be in the query's include mask. Ticks are per `(archetype, component)` — touching one row flags the whole archetype for that component.

## 11. Query Composition

Queries refine by chaining; each method returns a new (cached) query.

```ts
const alive     = world.query(Pos).and(Health);                    // include Pos AND Health
const active    = world.query(Pos).and(Health).not(Dead);          // exclude Dead
const afflicted = world.query(Health).any_of(Poison, Fire);        // at least one of
const targets   = world.query(Pos).and(Health).not(Shield).any_of(IsEnemy, IsBoss);
```

Inside `register_system`, use `qb.every(...)` and chain the same way: `(qb) => qb.every(Pos, Vel).not(Dead)`. Identical filter sets resolve to the same cached `Query` instance, so `world.query(...)` is cheap ad-hoc.

## 12. Complete Example

Entities move, a damage handler applies HP deltas from queued events, a death system tags corpses, cleanup destroys them, and a `ChangedQuery` counts archetypes that moved this frame.

```ts
import {
  ECS,
  SCHEDULE,
  event_key,
  resource_key,
  type EntityID,
} from "@oasys/oecs";

const world = new ECS();

// --- Components ---
const Pos    = world.register_component({ x: "f64", y: "f64" });
const Vel    = world.register_component(["vx", "vy"] as const);
const Health = world.register_component({ current: "i32", max: "i32" });
const Dead   = world.register_tag();

// --- Resource ---
const Time = resource_key<{ delta: number; elapsed: number }>("Time");
world.register_resource(Time, { delta: 0, elapsed: 0 });

// --- Event ---
const Hit = event_key<readonly ["target", "damage"]>("Hit");
world.register_event(Hit, ["target", "damage"] as const);

// --- Systems ---
const tickTime = world.register_system((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});

const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      const px = arch.get_column_mut(Pos, "x", ctx.world_tick);
      const py = arch.get_column_mut(Pos, "y", ctx.world_tick);
      const vx = arch.get_column(Vel, "vx");
      const vy = arch.get_column(Vel, "vy");
      for (let i = 0; i < arch.entity_count; i++) {
        px[i] += vx[i] * dt;
        py[i] += vy[i] * dt;
      }
    });
  },
  (qb) => qb.every(Pos, Vel).not(Dead),
);

// Change-detection observer: count archetypes whose Pos moved this frame.
let moved_archetypes_this_frame = 0;
const observeMoved = world.register_system(
  (q, _ctx, _dt) => {
    moved_archetypes_this_frame = 0;
    q.changed(Pos).for_each(() => { moved_archetypes_this_frame++; });
  },
  (qb) => qb.every(Pos),
);

// Apply queued damage events via a mutable ref.
const applyDamage = world.register_system((ctx, _dt) => {
  const hits = ctx.read(Hit);
  for (let i = 0; i < hits.length; i++) {
    const target = hits.target[i] as EntityID;
    if (!world.is_alive(target)) continue;     // guard stale handles
    const h = ctx.ref_mut(Health, target);
    h.current -= hits.damage[i];
  }
});

// Tag anything with hp <= 0 as Dead (deferred).
const markDead = world.register_system(
  (q, ctx, _dt) => {
    q.for_each((arch) => {
      const ids = arch.entity_ids;
      const hp = arch.get_column(Health, "current");
      for (let i = 0; i < arch.entity_count; i++) {
        if (hp[i] <= 0) ctx.add_component(ids[i] as EntityID, Dead);
      }
    });
  },
  (qb) => qb.every(Health).not(Dead),
);

// Deferred destruction of anything tagged Dead.
const cleanupDead = world.register_system(
  (q, ctx, _dt) => {
    q.for_each((arch) => {
      const ids = arch.entity_ids;
      for (let i = 0; i < arch.entity_count; i++) {
        ctx.destroy_entity(ids[i] as EntityID);
      }
    });
  },
  (qb) => qb.every(Dead),
);

// --- Schedule ---
world.add_systems(SCHEDULE.PRE_UPDATE, tickTime);
world.add_systems(
  SCHEDULE.UPDATE,
  moveSys,
  { system: observeMoved, ordering: { after: [moveSys] } },
  { system: applyDamage,  ordering: { after: [moveSys] } },
  { system: markDead,     ordering: { after: [applyDamage] } },
);
world.add_systems(SCHEDULE.POST_UPDATE, cleanupDead);

// --- Spawn ---
let first: EntityID = 0 as EntityID;
for (let i = 0; i < 100; i++) {
  const e = world.create_entity();
  world.add_components(e, [
    { def: Pos,    values: { x: Math.random() * 800, y: Math.random() * 600 } },
    { def: Vel,    values: { vx: (Math.random() - 0.5) * 100, vy: (Math.random() - 0.5) * 100 } },
    { def: Health, values: { current: 100, max: 100 } },
  ]);
  if (i === 0) first = e;
}

// Queue a damage event; readable on the first update() call.
world.emit(Hit, { target: first, damage: 40 });

// --- Run ---
world.startup();
world.update(1 / 60);
world.update(1 / 60);

console.log("moved archetypes:", moved_archetypes_this_frame);
console.log("alive entities:", world.entity_count);
```

## 13. Next Steps

- [Components](api/components.md), [Entities](api/entities.md), [Queries](api/queries.md), [Refs](api/refs.md)
- [Events](api/events.md), [Resources](api/resources.md), [Systems](api/systems.md), [Schedule](api/schedule.md)
- [Change Detection](api/change-detection.md) — tick model, `ChangedQuery`, archetype granularity.
- [Architecture](ARCHITECTURE.md) — internal design: store, archetypes, query cache.
- [Best Practices](BEST_PRACTICES.md) — performance tips, common pitfalls, idioms.
