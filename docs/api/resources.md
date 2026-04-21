# Resources

A resource is a world-scoped singleton value identified by a symbol key. Unlike components, resources are not attached to entities — one world holds exactly one value per key. They are the right fit for shared state like time, input, camera settings, asset tables, and other data with no natural owner entity.

Resources are keyed by `ResourceKey<T>`, a symbol carrying a phantom type parameter. The key is the only thing callers pass around; the stored value type is recovered from the key at every read/write site, so the API is fully type-safe with zero runtime tagging.

Unlike components, resource values are arbitrary — they are not constrained to numeric fields or typed arrays. A resource can hold an object, a string, a `Map`, a `Float32Array`, a class instance, or any other JavaScript value.

## Exports

```ts
import { resource_key, type ResourceKey } from "oecs";
```

Resource access lives on `World` and on `SystemContext`:

- `world.register_resource(key, value)`
- `world.resource(key)`
- `world.set_resource(key, value)`
- `world.has_resource(key)`
- `ctx.resource(key)`
- `ctx.set_resource(key, value)`
- `ctx.has_resource(key)`

## Defining Resource Keys

Use `resource_key<T>(name)` at module scope to create a key. The generic parameter `T` is the value type the key unlocks — all reads of the key return `T`, all writes require `T`.

```ts
import { resource_key } from "oecs";

export const Time = resource_key<{ delta: number; elapsed: number }>("Time");
export const Settings = resource_key<{ volume: number; muted: boolean }>("Settings");
export const FrameBuffer = resource_key<Float32Array>("FrameBuffer");
```

`ResourceKey<T>` is defined as:

```ts
export type ResourceKey<T> = symbol & { readonly __phantom: T };
```

At runtime the key is a plain `Symbol(name)` — the `name` is for debugging only. The phantom `T` exists only at compile time; it carries the value type through the API without any runtime cost. Two calls to `resource_key("Time")` produce two distinct keys, so always export a single module-scope constant and import it everywhere the resource is touched.

## Registering a Resource

`register_resource` inserts the initial value into the world. It must be called exactly once per key before any read or `set_resource`.

```ts
world.register_resource(Time, { delta: 0, elapsed: 0 });
world.register_resource(Settings, { volume: 1, muted: false });
world.register_resource(FrameBuffer, new Float32Array(1024));
```

The value argument is typed as `T` from the key, so registering with the wrong shape is a compile error. Registering the same key twice throws `RESOURCE_ALREADY_REGISTERED`.

## Reading a Resource

`resource(key)` returns the stored value, typed as `T`.

```ts
const time = world.resource(Time);       // { delta: number; elapsed: number }
const buf = world.resource(FrameBuffer); // Float32Array
```

Inside a system, read through the `SystemContext`:

```ts
world.register_system((ctx, dt) => {
  const time = ctx.resource(Time);
  time.elapsed += dt;
  time.delta = dt;
});
```

The returned value is the same reference stored in the world. For object resources, mutating its properties mutates the stored resource directly — no copy is made on read. Reading an unregistered key throws `RESOURCE_NOT_REGISTERED`.

## Writing a Resource

`set_resource(key, value)` replaces the stored value.

```ts
world.set_resource(Settings, { volume: 0.5, muted: false });
```

From a system:

```ts
world.register_system((ctx, dt) => {
  const prev = ctx.resource(Time);
  ctx.set_resource(Time, { delta: dt, elapsed: prev.elapsed + dt });
});
```

Use `set_resource` when swapping in a fresh value (for example replacing a typed array, or resetting a struct). When you just need to update a field on an object resource, mutating the reference returned from `resource()` is equivalent and avoids allocating a new object. Calling `set_resource` on an unregistered key throws `RESOURCE_NOT_REGISTERED`.

## Checking Existence

`has_resource(key)` returns `true` if the key has been registered.

```ts
if (!world.has_resource(Time)) {
  world.register_resource(Time, { delta: 0, elapsed: 0 });
}
```

Available on both `World` and `SystemContext`. This is the only resource method that does not throw on a missing key.

## Common Patterns

### Time / clock

A single per-frame time resource shared by every system:

```ts
const Time = resource_key<{ delta: number; elapsed: number }>("Time");
world.register_resource(Time, { delta: 0, elapsed: 0 });

const advance_time = world.register_system((ctx, dt) => {
  const t = ctx.resource(Time);
  t.delta = dt;
  t.elapsed += dt;
});
world.add_systems(SCHEDULE.FIRST, advance_time);
```

### Input state

A mutable input snapshot updated by one system and read by many:

```ts
const Input = resource_key<{
  keys: Set<string>;
  mouse_x: number;
  mouse_y: number;
}>("Input");

world.register_resource(Input, { keys: new Set(), mouse_x: 0, mouse_y: 0 });

// One system writes:
const poll_input = world.register_system((ctx) => {
  const input = ctx.resource(Input);
  input.mouse_x = device.mouse_x;
  input.mouse_y = device.mouse_y;
});

// Others read:
const player_control = world.register_system(
  (q, ctx) => {
    const input = ctx.resource(Input);
    q.for_each((arch) => {
      const vx = arch.get_column(Vel, "vx");
      if (input.keys.has("ArrowRight")) {
        for (let i = 0; i < arch.entity_count; i++) vx[i] = 100;
      }
    });
  },
  (qb) => qb.every(Vel, IsPlayer),
);
```

### Config objects

Static or rarely-changing settings read by many systems:

```ts
interface GameConfig {
  gravity: number;
  max_enemies: number;
  difficulty: "easy" | "hard";
}

const Config = resource_key<GameConfig>("Config");
world.register_resource(Config, { gravity: 9.8, max_enemies: 50, difficulty: "easy" });

// Swap in a new config at runtime:
world.set_resource(Config, { gravity: 20, max_enemies: 200, difficulty: "hard" });
```

### Non-plain value types

Because `T` is arbitrary, resources can hold anything:

```ts
const Assets = resource_key<Map<string, ImageBitmap>>("Assets");
world.register_resource(Assets, new Map());

const Scratch = resource_key<Float64Array>("Scratch");
world.register_resource(Scratch, new Float64Array(4096));

class AudioEngine { /* ... */ }
const Audio = resource_key<AudioEngine>("Audio");
world.register_resource(Audio, new AudioEngine());
```

## Notes

- **Singleton per world.** Resources are not attached to entities and are not filtered by queries. A world holds exactly one value per key.
- **Lifetime tied to the world.** Resources live in the world's internal `Map<symbol, T>`. They persist across ticks and schedule phases until the world is discarded.
- **No change detection.** Unlike components (which track a changed tick per archetype), resources are not versioned. `ChangedQuery` and related filters do not apply. If you need "did this change this frame", track it explicitly on the resource value.
- **Reads return the live reference.** Mutating an object resource through `resource(key)` is visible to all subsequent reads with no further action needed.
- **Keys are distinct per call.** `resource_key("X")` creates a new symbol every time. Export each key as a single module-scope constant.
- **Errors.** Registering an already-registered key throws `RESOURCE_ALREADY_REGISTERED`. Reading, writing, or accessing an unregistered key (other than via `has_resource`) throws `RESOURCE_NOT_REGISTERED`.
