# oecs

A fast, minimal, archetype-based Entity Component System for TypeScript.

## Features

- **Archetype-based SoA storage.** Entities sharing a component set share contiguous typed-array columns — cache-friendly loops, no per-entity object allocation.
- **Phantom-typed components.** `ComponentDef<{ x: "f64", y: "f64" }>` is a branded integer at runtime and a fully-typed schema at compile time. Misspelled fields are compile errors.
- **Callback iteration.** `query.for_each(arch => ...)` yields non-empty archetypes; you write the row loop over typed-array columns.
- **Tick-based change detection.** Each `(archetype, component)` tracks a change tick. `query.changed(Pos).for_each(...)` visits only archetypes mutated since the system's last run.
- **Key-based events and resources.** `event_key<F>` / `resource_key<T>` create module-scope symbol handles carrying their schema as a phantom — import the key anywhere.
- **Cached single-entity refs.** `ctx.ref` / `ctx.ref_mut` give ergonomic `pos.x += vel.vx * dt` that compiles to a direct typed-array index op.
- **Deferred structural changes.** `ctx.add_component` / `ctx.remove_component` / `ctx.destroy_entity` buffer until the schedule flushes between phases, so iterators stay valid.
- **Topological scheduler.** Per-phase Kahn's-algorithm sort over a binary heap, with insertion order as a deterministic tiebreaker.
- **Fixed timestep.** Accumulator loop with configurable `fixed_timestep` and spiral-of-death protection.
- **Reusable primitives.** `BitSet`, `SparseSet`, `SparseMap`, `GrowableTypedArray`, `BinaryHeap`, `topological_sort` all exported.

## Installation

```bash
pnpm add @oasys/oecs
```

## Quick start

```ts
import { ECS, SCHEDULE, event_key, resource_key } from "@oasys/oecs";

// Keys — module scope, phantom-typed
const Time = resource_key<{ delta: number; elapsed: number }>("Time");
const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");

const world = new ECS();

// Components
const Pos = world.register_component({ x: "f64", y: "f64" });
const Vel = world.register_component(["vx", "vy"] as const);

// Resources & events
world.register_resource(Time, { delta: 0, elapsed: 0 });
world.register_event(DamageEvent, ["target", "amount"] as const);

// Entities
const e = world.create_entity();
world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 100, vy: 50 } },
]);

// System — query resolved once at registration
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

world.add_systems(SCHEDULE.UPDATE, moveSys);
world.startup();

let last = performance.now();
function frame() {
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  const t = world.resource(Time);
  world.set_resource(Time, { delta: dt, elapsed: t.elapsed + dt });
  world.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

## World options

```ts
const world = new ECS({
  initial_capacity: 4096,
  fixed_timestep: 1 / 50,
  max_fixed_steps: 4,
});
```

| Option             | Type     | Default | Description |
| ------------------ | -------- | ------- | ----------- |
| `initial_capacity` | `number` | `1024`  | Starting size of each archetype's entity-ID and column buffers. Buffers double on overflow; pick close to your expected per-archetype entity count to avoid early reallocations. |
| `fixed_timestep`   | `number` | `1/60`  | Interval (seconds) at which `SCHEDULE.FIXED_UPDATE` systems run. |
| `max_fixed_steps`  | `number` | `5`     | Hard cap on fixed-update iterations per frame. Protects against spiral of death. |

## Components

Records give per-field type control; array shorthand defaults to `f64`. Tags have no fields.

```ts
const Pos = world.register_component({ x: "f64", y: "f64" });
const Health = world.register_component({ current: "i32", max: "i32" });
const Vel = world.register_component(["vx", "vy"] as const);
const IsEnemy = world.register_tag();

world.add_components(e, [
  { def: Pos, values: { x: 0, y: 0 } },
  { def: Vel, values: { vx: 1, vy: 0 } },
  { def: IsEnemy },
]);
```

Supported tags: `f32`, `f64`, `i8`, `i16`, `i32`, `u8`, `u16`, `u32`.

See [docs/api/components.md](docs/api/components.md).

## Queries

Live, cached views over matching archetypes. Iterate with `for_each`.

```ts
const q = world.query(Pos, Vel);

q.for_each((arch) => {
  const px = arch.get_column(Pos, "x");
  const py = arch.get_column(Pos, "y");
  for (let i = 0; i < arch.entity_count; i++) { /* ... */ }
});

// Chaining returns new cached queries
const targets = world.query(Pos).and(Health).not(Shield).any_of(IsEnemy, IsBoss);

// Change detection — only archetypes whose Pos column changed since last run
q.changed(Pos).for_each((arch) => { /* ... */ });
```

See [docs/api/queries.md](docs/api/queries.md) and [docs/api/change-detection.md](docs/api/change-detection.md).

## Systems

Systems are plain functions. Three registration shapes all return a `SystemDescriptor`.

```ts
// Bare function
const logSys = world.register_system((ctx, dt) => { /* ... */ });

// Function + query builder (query resolved once at registration)
const moveSys = world.register_system(
  (q, ctx, dt) => { q.for_each((arch) => { /* ... */ }); },
  (qb) => qb.every(Pos, Vel),
);

// Full config — lifecycle hooks, name
const spawnSys = world.register_system({
  name: "spawn",
  fn(ctx, dt) { /* every frame */ },
  on_added(ctx) { /* once during world.startup() */ },
  dispose() { /* during world.dispose() */ },
});
```

`SystemContext` exposes deferred structural ops, per-entity access, events, resources, and tick bookkeeping (`ctx.world_tick`, `ctx.last_run_tick`).

See [docs/api/systems.md](docs/api/systems.md).

## Resources

Global singletons keyed by `ResourceKey<T>`. Values can be any type — objects, typed arrays, class instances.

```ts
import { resource_key } from "@oasys/oecs";

const Time = resource_key<{ delta: number; elapsed: number }>("Time");
const Assets = resource_key<Map<string, ImageBitmap>>("Assets");

world.register_resource(Time, { delta: 0, elapsed: 0 });
world.register_resource(Assets, new Map());

const t = world.resource(Time);                         // typed as { delta, elapsed }
world.set_resource(Time, { delta: 0.016, elapsed: 0 }); // swap in a new value
```

See [docs/api/resources.md](docs/api/resources.md).

## Events

Fire-and-forget SoA channels. Data events carry typed fields; signals carry only a count. Cleared at the end of each `world.update(dt)`.

```ts
import { event_key, signal_key } from "@oasys/oecs";

const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");
const GameOver = signal_key("GameOver");

world.register_event(DamageEvent, ["target", "amount"] as const);
world.register_signal(GameOver);

ctx.emit(DamageEvent, { target: victimId, amount: 25 });
ctx.emit(GameOver);

const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  dmg.target[i]; dmg.amount[i]; // number columns
}
if (ctx.read(GameOver).length > 0) { /* fired */ }
```

See [docs/api/events.md](docs/api/events.md).

## Refs

Cached single-entity handles — resolve archetype + row + column once, then read/write fields by name.

```ts
const pos = ctx.ref_mut(Pos, entity); // writable; bumps Pos change tick
const vel = ctx.ref(Vel, entity);     // readonly
pos.x += vel.vx * dt;
pos.y += vel.vy * dt;
```

Prefer `ctx.ref` by default; reach for `ctx.ref_mut` at the point of mutation. Do not hold refs across archetype transitions or phase flushes.

See [docs/api/refs.md](docs/api/refs.md).

## Schedule

Seven phases run in a fixed order:

| Phase          | When                             | Typical use             |
| -------------- | -------------------------------- | ----------------------- |
| `PRE_STARTUP`  | Once, before `STARTUP`           | Resource loading        |
| `STARTUP`      | Once                             | Initial entity spawning |
| `POST_STARTUP` | Once, after `STARTUP`            | Validation              |
| `FIXED_UPDATE` | Zero+ times per frame (fixed dt) | Physics, simulation     |
| `PRE_UPDATE`   | Every frame, first               | Input, time             |
| `UPDATE`       | Every frame                      | Game logic, AI          |
| `POST_UPDATE`  | Every frame, last                | Rendering, cleanup      |

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, damageSys, {
  system: deathSys,
  ordering: { after: [damageSys] },
});
```

Within a phase, systems are topologically sorted by `before` / `after` constraints. `ctx.flush()` runs automatically between phases.

See [docs/api/schedule.md](docs/api/schedule.md).

## Entity lifecycle

```ts
const e = world.create_entity();
world.is_alive(e);                // true
world.destroy_entity_deferred(e);
world.flush();
world.is_alive(e);                // false
```

`EntityID` is a packed 31-bit integer (20-bit slot index, 11-bit generation). Destroying an entity bumps its slot's generation, so stale handles are detected as dead. Inside systems, use `ctx.create_entity()` (immediate) and `ctx.destroy_entity(e)` (deferred).

See [docs/api/entities.md](docs/api/entities.md).

## Dev vs Prod modes

A compile-time `__DEV__` flag gates runtime sanity checks: bounds checks, liveness checks, duplicate-system detection, and registration validation. These are tree-shaken out of production bundles by the Vite build. Scheduler cycle detection is always active and throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY` on the first offending run.

## Development

```bash
pnpm install
pnpm test            # vitest
pnpm bench           # vitest bench
pnpm build           # vite library build
pnpm tsc --noEmit    # type check
```

## Guides

- [Getting Started](docs/GETTING_STARTED.md) — step-by-step tutorial.
- [Best Practices](docs/BEST_PRACTICES.md) — component design, query patterns, pitfalls.
- [Architecture](docs/ARCHITECTURE.md) — data layout, flush model, cache invalidation.
- API reference:
  [components](docs/api/components.md) ·
  [entities](docs/api/entities.md) ·
  [queries](docs/api/queries.md) ·
  [systems](docs/api/systems.md) ·
  [schedule](docs/api/schedule.md) ·
  [resources](docs/api/resources.md) ·
  [events](docs/api/events.md) ·
  [refs](docs/api/refs.md) ·
  [change detection](docs/api/change-detection.md) ·
  [type primitives](docs/api/type-primitives.md)

## License

MIT
