# Systems

A system in oecs is a plain function from a `SystemContext` (plus `delta_time`) to side effects on the world. Systems carry no hidden state: all world access goes through the `ctx` argument they receive each frame. Systems are registered with `world.register_system(...)`, which returns a `SystemDescriptor`, and then scheduled into a phase (for example `SCHEDULE.UPDATE`) via `world.add_systems(...)`. Within a phase, systems are topologically sorted by `before` / `after` constraints and run in that order.

## Exports

From the package root:

- `SystemContext` — class, the runtime handle passed to every system.
- `SystemFn` — `(ctx: SystemContext, delta_time: number) => void`.
- `SystemConfig` — `{ fn, name?, on_added?, on_removed?, dispose? }`.
- `SystemDescriptor` — frozen handle returned by `register_system`.
- `SCHEDULE` — enum of phase labels.
- `SystemEntry`, `SystemOrdering` — ordering payload for `add_systems`.

## Defining a system

`register_system` has three overloads. All three return a `SystemDescriptor`.

### Bare function

```ts
const logSys = world.register_system((ctx, dt) => {
  // runs every frame while scheduled
});
```

### Function + query builder

The query is resolved once at registration time and captured in the closure.

```ts
const moveSys = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      const px = arch.get_column(Pos, "x");
      const vx = arch.get_column(Vel, "vx");
      for (let i = 0; i < arch.entity_count; i++) px[i] += vx[i] * dt;
    });
  },
  (qb) => qb.every(Pos, Vel),
);
```

### Full config

Use this form when you need lifecycle hooks or a label.

```ts
interface SystemConfig {
  fn: (ctx: SystemContext, delta_time: number) => void;
  name?: string;
  on_added?: (ctx: SystemContext) => void;
  on_removed?: () => void;
  dispose?: () => void;
}

const sys = world.register_system({
  name: "physics",
  fn(ctx, dt) { /* every frame */ },
  on_added(ctx) { /* once, during world.startup() */ },
  on_removed() { /* when world.remove_system(sys) is called */ },
  dispose() { /* during world.dispose() */ },
});
```

`SystemDescriptor` is `Readonly<SystemConfig> & { readonly id: SystemID }` and is frozen at registration.

## `SystemContext` API

Every system receives a single shared `SystemContext` bound to the world's `Store`. It wraps the store with deferred structural operations so that iterators stay valid while a system runs.

### World access

- **`public readonly store: Store`** — the underlying data store. Exposed publicly so systems and helpers can reach into lower-level APIs when needed.

### Queries and resources

Queries are not created through `ctx`; they come from the `QueryBuilder` at registration time, or from `world.query(...)`. `ctx` exposes resources by key:

- `resource<T>(key: ResourceKey<T>): T` — read a registered resource. (tick)
- `set_resource<T>(key: ResourceKey<T>, value: T): void` — replace a resource.
- `has_resource<T>(key: ResourceKey<T>): boolean` — test presence.

### Events

- `emit(key: EventKey<readonly []>): void` — emit a signal (payload-less).
- `emit<F>(key: EventKey<F>, values: { [K in F[number]]: number }): void` — emit a structured event.
- `read<F>(key: EventKey<F>): EventReader<F>` — obtain this frame's event reader.

### Entities

- `create_entity(): EntityID` — **immediate**; returns a live id.
- `destroy_entity(id: EntityID): this` — **deferred** until the next flush.
- `add_component(entity, def): this` — deferred (tag overload).
- `add_component(entity, def, values): this` — deferred.
- `remove_component(entity, def): this` — deferred.
- `flush(): void` — apply buffered structural changes, then destructions. Called automatically after each phase; call it manually only when a system must observe its own structural edits.

### Per-entity field access

- `get_field(entity, def, field): number` — direct read; looks up archetype + row each call.
- `set_field(entity, def, field, value): void` — direct write; marks the column as changed this tick.
- `ref(def, entity): ReadonlyComponentRef<S>` — cached read-only reference.
- `ref_mut(def, entity): ComponentRef<S>` — cached mutable reference; marks the component as changed this tick.

### Change detection (tick)

- **`public last_run_tick: number`** — tick value at the start of this system's most recent run. `0` on the first run. Set by the schedule immediately before `fn` is invoked. (tick)
- **`public get world_tick(): number`** — the current world tick, read from `store._tick`. Use this as the write tick when calling `arch.get_column_mut(def, field, tick)` directly from inside a system. (tick)

`ChangedQuery.for_each` consults `ctx.last_run_tick` (via the query resolver) to decide which archetypes to visit — see the example below.

## Phases

`SCHEDULE` defines seven phases, grouped into three run windows:

| Phase                    | Runs in                | When                                         |
| ------------------------ | ---------------------- | -------------------------------------------- |
| `SCHEDULE.PRE_STARTUP`   | `world.startup()`      | Once, before `STARTUP`.                      |
| `SCHEDULE.STARTUP`       | `world.startup()`      | Once.                                        |
| `SCHEDULE.POST_STARTUP`  | `world.startup()`      | Once, after `STARTUP`.                       |
| `SCHEDULE.FIXED_UPDATE`  | `world.update(dt)`     | Zero or more times per call, at a fixed dt. |
| `SCHEDULE.PRE_UPDATE`    | `world.update(dt)`     | Every call.                                  |
| `SCHEDULE.UPDATE`        | `world.update(dt)`     | Every call.                                  |
| `SCHEDULE.POST_UPDATE`   | `world.update(dt)`     | Every call.                                  |

Startup phases run in order `PRE_STARTUP → STARTUP → POST_STARTUP`. Each `world.update(dt)` advances the fixed-timestep accumulator, runs `FIXED_UPDATE` zero or more times at `world.fixed_timestep`, then runs `PRE_UPDATE → UPDATE → POST_UPDATE`, clears transient events, and increments the world tick. Startup systems receive `STARTUP_DELTA_TIME` as `dt`.

After every phase, `ctx.flush()` is called so the next phase sees a consistent world.

## Ordering with labels

Within a phase, systems are sorted topologically using Kahn's algorithm. Insertion order is a stable tiebreaker. Attach constraints via a `SystemEntry`:

```ts
import { SCHEDULE } from "oecs";

world.add_systems(
  SCHEDULE.UPDATE,
  inputSys,
  { system: moveSys, ordering: { after: [inputSys] } },
  { system: renderSys, ordering: { after: [moveSys] } },
);
```

`ordering.before` / `ordering.after` take `SystemDescriptor[]`. A cycle inside a single phase throws `ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY`. Ordering constraints only apply within the same phase; to sequence across phases, place systems in different `SCHEDULE` labels. See `schedule.md` for the full execution model.

## Examples

### A typical system

```ts
const physicsSys = world.register_system(
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

world.add_systems(SCHEDULE.UPDATE, physicsSys);
```

### Change-detection aware system

`ChangedQuery.for_each` iterates only archetypes whose change tick for one of the requested components is `>= ctx.last_run_tick`. On the first run, `last_run_tick` is `0`, so every non-empty matching archetype is visited once.

```ts
const syncTransformSys = world.register_system(
  (q, ctx, _dt) => {
    const changed = q.changed(Pos);
    changed.for_each((arch) => {
      const px = arch.get_column(Pos, "x");
      const py = arch.get_column(Pos, "y");
      const tx = arch.get_column_mut(Transform, "x", ctx.world_tick);
      const ty = arch.get_column_mut(Transform, "y", ctx.world_tick);
      for (let i = 0; i < arch.entity_count; i++) {
        tx[i] = px[i];
        ty[i] = py[i];
      }
    });
  },
  (qb) => qb.every(Pos, Transform),
);
```

### Signal-handling system

```ts
const ResetSignal = signal_key("game/reset");
world.register_signal(ResetSignal);

const resetSys = world.register_system((ctx, _dt) => {
  const reader = ctx.read(ResetSignal);
  if (reader.length === 0) return;
  // Respond once per emission this frame.
  ctx.set_resource(Score, { value: 0 });
});

world.add_systems(SCHEDULE.PRE_UPDATE, resetSys);
```

## Notes

- System functions should be pure-ish with respect to their arguments: they may mutate world state through `ctx`, but should not rely on hidden module-level state that would break if the system is re-registered, removed, or called after `world.dispose()`.
- `ctx.last_run_tick` is `0` on a system's first run. Guard against this when a change-detection system needs to distinguish "first run" from "nothing changed".
- Structural edits (`add_component`, `remove_component`, `destroy_entity`) are deferred to the end of the phase. If a system needs its own writes visible before the phase ends, call `ctx.flush()` explicitly.
- `ctx.create_entity()` is immediate, but a newly created entity has no components until an `add_component` call is flushed.
- `on_added` runs once during `world.startup()`, before any `PRE_STARTUP` systems execute; `on_removed` runs synchronously inside `world.remove_system(sys)` and again during `world.dispose()`; `dispose` runs during `world.dispose()`.
