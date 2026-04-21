# Events

Events are fire-and-forget messages that systems emit within a frame and other systems read during the same frame. Fields are stored in SoA (Structure of Arrays) layout -- each field is a backing `number[]` column exposed by the reader. All event channels are cleared automatically at the end of every `world.update()` call, after all phases have run.

Signals are zero-field events: they carry no payload, just a count of how many times they were emitted.

## Exports

```ts
import {
  event_key,
  signal_key,
  type EventKey,
  type EventReader,
} from "oecs";
```

Worlds expose `register_event`, `register_signal`, `emit`, and `read`. Systems receive the same `emit` / `read` on their `SystemContext`.

## Defining events

Events are identified by module-scope `EventKey` symbols. Create a key once with `event_key<F>(name)`, passing the field tuple as a type parameter, then import that key anywhere you need to emit or read.

```ts
import { event_key } from "oecs";

export const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");
export const ScoreEvent = event_key<readonly ["value"]>("Score");
```

The type parameter `F` is a phantom -- it lives only at compile time and flows through `emit`/`read` for type safety. The string argument is the Symbol description, useful in debugging.

`EventKey<F>` is a branded `symbol`. Module scope keeps identity stable across imports.

## Registering an event

`world.register_event(KEY, fields)` creates the SoA channel for a key. It returns `void` -- the `EventKey` itself is the handle used everywhere else.

```ts
world.register_event(DamageEvent, ["target", "amount"] as const);
world.register_event(ScoreEvent, ["value"] as const);
```

Each key must be registered exactly once; re-registering the same key throws `EVENT_ALREADY_REGISTERED`. Registration is typically done in plugin/setup code, before `world.startup()`.

The `fields` tuple at runtime must match the phantom `F` the key was declared with. Use `as const` so the tuple narrows to literal strings.

## Signals

Signals are zero-field events. Use the `signal_key(name)` factory and `world.register_signal(KEY)` to register them.

```ts
import { signal_key } from "oecs";

export const GameOver = signal_key("GameOver");

world.register_signal(GameOver);
```

`signal_key` returns `EventKey<readonly []>`, which makes the zero-argument `emit` overload the only one that type-checks for this key.

Signals skip the column-push entirely and only increment a counter, so they are significantly cheaper than data events.

## Emitting

`world.emit(KEY, data)` appends one row to the event channel. The `data` object is typed against the key's field tuple.

```ts
// Outside systems (setup, input handlers)
world.emit(DamageEvent, { target: entityId, amount: 50 });
world.emit(GameOver);
```

Inside systems, use `ctx.emit`:

```ts
const attackSystem = world.register_system(
  (q, ctx, dt) => {
    q.for_each((arch) => {
      // ...
      ctx.emit(DamageEvent, { target: victim, amount: dmg });
      ctx.emit(GameOver);
    });
  },
  (qb) => qb.every(Attack),
);
```

The two `emit` overloads are:

```ts
emit(key: EventKey<readonly []>): void;
emit<F>(key: EventKey<F>, values: { readonly [K in F[number]]: number }): void;
```

TypeScript picks the right one from the key's phantom field tuple. Passing `values` to a signal key, or omitting them for a data event, is a compile error.

## Reading

`ctx.read(KEY)` (or `world.read(KEY)`) returns an `EventReader<F>` -- a live view over the channel's SoA columns.

```ts
type EventReader<F> = { length: number } & {
  readonly [K in F[number]]: readonly number[];
};
```

The reader exposes one `number[]` per field plus a `length` property. Each field property **is** the backing column -- access is zero-copy, no allocation per read.

```ts
const dmg = ctx.read(DamageEvent);
for (let i = 0; i < dmg.length; i++) {
  const target = dmg.target[i]; // number
  const amount = dmg.amount[i]; // number
}
```

For signals, only `length` is meaningful:

```ts
if (ctx.read(GameOver).length > 0) {
  // fired at least once this frame
}
```

The reader object is stable: the same reference is reused across frames. Don't hold onto column slices -- iterate up to `length` and read in-place.

## Lifecycle

Events live for exactly one frame. `world.update(dt)` runs, in order:

```
world.update(dt)
  -> run FIXED_UPDATE phases (if any, via accumulator)
  -> run PRE_UPDATE phase         <- systems can emit events
  -> run UPDATE phase             <- systems can read events emitted earlier this frame
  -> run POST_UPDATE phase        <- last chance to read events
  -> clear all event channels     <- length resets to 0, columns truncated
  -> tick++
```

The flush happens in `world.update()` after `schedule.run_update(...)` returns and before the tick increments. Events emitted during one `update` call are visible to every subsequent system in the same call, then discarded before the next one.

Signals follow the same lifecycle: their count resets to 0 each frame.

## Why key-based

`EventKey<F>` is a branded symbol carrying the field schema as a phantom type:

- **Compile-time safety.** The phantom `F` flows through `emit` and `read`, so the value object for `emit` and the column names on the reader are fully typed from the key alone. Misspelling a field or mixing up keys is a type error.
- **Module-scope identity.** Keys are defined at module scope (like `ResourceKey`) and imported wherever needed. No central registry, no registration-order coupling -- the key you import is the one the world registered.
- **Decoupled definition and registration.** A key can be declared in a shared module and registered by whichever plugin owns it. Consumers import the key; they don't need to know which plugin owns the channel.

This mirrors the pattern used by `ResourceKey` / `resource_key`, keeping the API surface consistent across events and resources.
