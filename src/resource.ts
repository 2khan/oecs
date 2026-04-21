/***
 * Resource — Typed singleton key-value storage.
 *
 * Resources are global singletons that don't belong to any entity.
 * Think: time, input state, camera config, game settings.
 *
 * Each resource is identified by a unique symbol (ResourceKey<T>) and
 * stores an arbitrary typed value. The key carries the value type as a
 * phantom type parameter, so reads are type-safe at compile time.
 *
 * Usage:
 *
 *   const TimeRes = resource_key<{ delta: number; elapsed: number }>("Time");
 *   world.register_resource(TimeRes, { delta: 0, elapsed: 0 });
 *   const time = world.resource(TimeRes);
 *   // time.delta → number, time.elapsed → number
 *
 ***/

import { unsafe_cast } from "./type_primitives";

export type ResourceKey<T> = symbol & { readonly __phantom: T };

export function resource_key<T>(name: string): ResourceKey<T> {
  return unsafe_cast<ResourceKey<T>>(Symbol(name));
}
