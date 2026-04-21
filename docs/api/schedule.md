# Schedule

The scheduler orders systems within each lifecycle phase under user-declared
`before` / `after` constraints, then runs them in that order. Execution is
driven by the world: `world.startup()` runs the startup phases once, and
`world.update(dt)` runs the fixed-update loop (when populated) followed by the
update phases every frame. After every phase, `ctx.flush()` is called so the
next phase observes a consistent store.

The sort result is cached per phase and invalidated when systems are added or
removed.

## Exports

```ts
import {
  SCHEDULE,
  type SystemEntry,
  type SystemOrdering,
} from "oecs";
```

The `Schedule` class itself is internal; user code interacts with it through
`ECS.add_systems`, `ECS.remove_system`, `ECS.startup`, and `ECS.update`.

## Phases

Seven phases execute in a fixed order:

```
Startup (once):           PRE_STARTUP → STARTUP → POST_STARTUP
Fixed update (per step):  FIXED_UPDATE
Update (per frame):       PRE_UPDATE  → UPDATE  → POST_UPDATE
```

| Phase | Fires | Driven by |
|---|---|---|
| `PRE_STARTUP` | Once, before `STARTUP` | `world.startup()` |
| `STARTUP` | Once | `world.startup()` |
| `POST_STARTUP` | Once, after `STARTUP` | `world.startup()` |
| `FIXED_UPDATE` | Zero or more times per frame at a fixed `dt` | `world.update(dt)` accumulator loop |
| `PRE_UPDATE` | Every frame, first | `world.update(dt)` |
| `UPDATE` | Every frame | `world.update(dt)` |
| `POST_UPDATE` | Every frame, last | `world.update(dt)` |

`world.update(dt)` first advances the fixed-update accumulator and drains it at
`fixed_timestep` intervals (skipped entirely when `FIXED_UPDATE` has no
systems), then runs `PRE_UPDATE → UPDATE → POST_UPDATE` with the original `dt`.

## Ordering Constraints

`add_systems` accepts either a bare `SystemDescriptor` or a `SystemEntry` with
an `ordering` object:

```ts
interface SystemOrdering {
  before?: SystemDescriptor[];
  after?: SystemDescriptor[];
}

interface SystemEntry {
  system: SystemDescriptor;
  ordering?: SystemOrdering;
}
```

Both arrays hold system labels (the descriptors returned by
`world.register_system`). References to systems in other phases are ignored —
ordering only constrains peers within the same phase.

```ts
world.add_systems(SCHEDULE.UPDATE, moveSys, {
  system: physicsSys,
  ordering: { after: [moveSys] },
});

world.add_systems(SCHEDULE.UPDATE, {
  system: aiSys,
  ordering: { before: [moveSys] },
});
```

In dev builds, adding the same system twice throws
`ECSError(DUPLICATE_SYSTEM)`.

## Tie-Breaking

Every system receives an `insertion_order` counter when it is added. When two
or more systems are simultaneously ready (their dependencies have all run), the
one with the lower `insertion_order` runs first. This guarantees deterministic
output: the sort result for a given set of systems and constraints is always
identical across runs.

## Topological Ordering

Sorting delegates to the shared `topological_sort` primitive (`Kahn's algorithm`
with a `BinaryHeap`-backed ready queue, seeded by the `insertion_order`
comparator). The schedule builds an adjacency map from the `before` / `after`
constraints:

- `before: [X]` on a system adds edge `this → X`.
- `after: [X]` on a system adds edge `X → this`.

Edges that point at systems in other phases are filtered out before the sort,
so cross-phase labels are silent no-ops rather than errors. See the
type-primitives module for the full primitive contract.

## Cycle Detection

The `topological_sort` primitive throws a built-in `TypeError` when some nodes
cannot be scheduled. The schedule catches it and re-throws as
`ECSError(CIRCULAR_SYSTEM_DEPENDENCY)` with a message containing the phase
label and the names of the systems still pending:

```
Circular system dependency detected in UPDATE: Cycle detected in topological sort.
Nodes still pending: physicsSys, moveSys
```

Cycles are checked eagerly on the first run after systems change — the error
throws from `world.update` or `world.startup`, not from `add_systems`.

## Per-System Tick Bookkeeping

The schedule keeps a `system_last_run` map keyed by descriptor. Before invoking
each system, the schedule writes the current tick into that map and assigns it
to `ctx.last_run_tick`. Systems read it through the shared `SystemContext`:

```ts
const ageSys = world.register_system((ctx, dt) => {
  const since = ctx.world_tick - ctx.last_run_tick;
  // ...
});
```

`ctx.last_run_tick` reflects the tick the currently running system last
executed; `ctx.world_tick` reflects the tick the world is currently on.
`ChangedQuery` uses this value internally to report rows modified since the
system's previous run.

`remove_system` clears the descriptor's entry; `clear()` drops the whole map.

## Driving the Schedule Directly

`ECS.update()` wires the tick automatically. Drivers that bypass the world
facade must pass an explicit `tick: number`:

```ts
class Schedule {
  run_startup(ctx: SystemContext, tick: number): void;
  run_update(ctx: SystemContext, delta_time: number, tick: number): void;
  run_fixed_update(ctx: SystemContext, fixed_dt: number, tick: number): void;
  has_fixed_systems(): boolean;
}
```

- `run_startup` executes `PRE_STARTUP → STARTUP → POST_STARTUP` using the
  constant `STARTUP_DELTA_TIME` as the delta.
- `run_update` executes `PRE_UPDATE → UPDATE → POST_UPDATE` with `delta_time`.
- `run_fixed_update` executes `FIXED_UPDATE` once with `fixed_dt`; call it in a
  loop off your own accumulator.

Each of these flushes `ctx` between phases and after the final phase. Pass a
monotonically increasing `tick` so `last_run_tick` bookkeeping stays coherent
with any change-detection queries.
