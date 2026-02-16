/***
 *
 * EntityRegistry - Allocates and recycles generational entity IDs
 *
 * The registry is, in essence, a seat-assignment desk for the theatre
 * described in entity.ts. It hands out seat numbers (indices) to new
 * arrivals and, when someone leaves, puts that seat back on a "free"
 * pile so the next arrival can reuse it - with a bumped generation so
 * any ticket stubs from the previous occupant are recognisably stale.
 *
 * Internal state:
 *
 *   generations    - A Uint16Array with one entry per seat. Stores the
 *                    current generation for that index as an unsigned
 *                    16-bit integer (max 65535, well above the 12-bit
 *                    MAX_GENERATION of 4095). The buffer starts at INITIAL_CAPACITY
 *                    and doubles when full, so we never pay for
 *                    per-element boxing or GC pressure on this hot path.
 *
 *   high_water     - The number of index slots that have ever been
 *                    allocated. Everything below this mark in the
 *                    generations buffer holds a meaningful value;
 *                    everything at or above is spare capacity.
 *
 *   free_indices[] - A LIFO stack of seats whose previous occupant has
 *                    left. We pop from here first before growing the
 *                    high-water mark, keeping memory compact.
 *
 *   alive_count    - How many entities are currently alive. Incremented
 *                    on create, decremented on destroy.
 *
 ***/

import {
  EntityID,
  MAX_GENERATION,
  get_entity_generation,
  create_entity_id,
  get_entity_index,
} from "./entity";
import { ECS_ERROR, ECSError } from "../utils/error";

export const INITIAL_CAPACITY = 64;

export class EntityRegistry {
  private generations = new Uint16Array(INITIAL_CAPACITY);
  private high_water = 0;
  private free_indices: number[] = [];
  private alive_count = 0;

  //=========================================================
  // Queries
  //=========================================================

  /** Number of entities currently alive. */
  public get count(): number {
    return this.alive_count;
  }

  /**
   * Check whether an ID refers to a living entity.
   *
   * Two conditions must hold:
   *   1. The index falls within the allocated range.
   *   2. The generation baked into the ID matches the
   *      current generation for that index.
   *
   * If the seat was recycled (generation bumped), any old
   * ID that still carries the previous generation will
   * correctly return false here.
   */
  public is_alive(id: EntityID): boolean {
    const index = get_entity_index(id);
    return (
      index < this.high_water &&
      this.generations[index] === get_entity_generation(id)
    );
  }

  //=========================================================
  // Mutations
  //=========================================================

  /**
   * Allocate a new entity.
   *
   * If there are recycled seats available we reuse one
   * (its generation was already bumped during destroy).
   * Otherwise we advance the high-water mark, growing
   * the backing buffer if needed, and start the fresh
   * seat at generation 0.
   */
  public create_entity(): EntityID {
    let index: number;
    let generation: number;

    if (this.free_indices.length > 0) {
      index = this.free_indices.pop()!;
      generation = this.generations[index]; // already bumped during destroy
    } else {
      index = this.high_water++;
      if (index >= this.generations.length) {
        this.grow();
      }
      this.generations[index] = 0;
      generation = 0;
    }

    this.alive_count++;
    return create_entity_id(index, generation);
  }

  /**
   * Destroy a living entity.
   *
   * Bumps the generation for this index (wrapping at
   * MAX_GENERATION) so that the old ID becomes stale,
   * then pushes the index onto the free list for reuse.
   *
   * Throws if the entity is already dead - destroying
   * the same ID twice is always a logic error.
   */
  public destroy(id: EntityID): void {
    const index = get_entity_index(id);
    const generation = get_entity_generation(id);

    if (index >= this.high_water || this.generations[index] !== generation) {
      if (__DEV__) throw new ECSError(ECS_ERROR.ENTITY_CANT_DESTROY_DEAD);
      return;
    }

    this.generations[index] = (generation + 1) & MAX_GENERATION;
    this.free_indices.push(index);
    this.alive_count--;
  }

  //=========================================================
  // Internal
  //=========================================================

  /**
   * Double the backing buffer.
   *
   * Uint16Array is fixed-size, so when we outgrow it we
   * allocate a new buffer at twice the capacity and copy
   * the existing data over. The amortised cost of this
   * doubling strategy is O(1) per create.
   */
  private grow(): void {
    const next = new Uint16Array(this.generations.length * 2);
    next.set(this.generations);
    this.generations = next;
  }
}
