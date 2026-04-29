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

/**
 * Module-scope handle for a typed resource. The phantom `T` parameter
 * carries the value type so {@link ECS.resource | resource},
 * {@link ECS.set_resource | set_resource}, and
 * {@link ECS.has_resource | has_resource} are type-checked end-to-end.
 *
 * Mint with {@link resource_key} once at module scope; register with
 * {@link ECS.register_resource}.
 */
export type ResourceKey<T> = symbol & { readonly __phantom: T };

/**
 * Mint a new {@link ResourceKey} for a resource of type `T`.
 *
 * @param name - Description used for the underlying `Symbol`. Aids
 *   debugging; not significant to identity.
 *
 * @example
 * ```ts
 * export const TimeRes = resource_key<{ delta: number; elapsed: number }>("Time");
 * world.register_resource(TimeRes, { delta: 0, elapsed: 0 });
 * const time = world.resource(TimeRes);
 * ```
 */
export function resource_key<T>(name: string): ResourceKey<T> {
  return unsafe_cast<ResourceKey<T>>(Symbol(name));
}
