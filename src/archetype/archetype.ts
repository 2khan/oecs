/***
 *
 * Archetype - Metadata-only grouping of entities by component signature
 *
 * An archetype tracks which entities share the same set of components.
 * It holds no component data - that lives in ComponentRegistry's typed
 * arrays indexed by entity index. Moving an entity between archetypes
 * only changes membership lists; no component data is copied.
 *
 * The signature is a sorted, frozen array of ComponentIDs. Sorting
 * ensures deterministic hashing and enables binary search for
 * has_component / matches checks.
 *
 * Entity membership uses a classic sparse-set backed by typed arrays:
 *   - entity_ids (Uint32Array, dense) holds packed EntityIDs
 *   - index_to_row (Int32Array, sparse) maps entity_index → row
 * Uint32Array is required because EntityIDs use unsigned coercion
 * (>>> 0) and can exceed Int32 range. The sentinel EMPTY_ROW = -1
 * marks unused slots since rows are always non-negative.
 *
 * Graph edges cache archetype transitions: "if I add/remove component X,
 * which archetype do I end up in?" These are lazily populated by the
 * Store and make repeated transitions O(1).
 *
 ***/

import { Brand, validate_and_cast } from "type_primitives";
import type { ComponentID } from "../component/component";
import { get_entity_index, type EntityID } from "../entity/entity";
import { ECS_ERROR, ECSError } from "../utils/error";

const INITIAL_DENSE_CAPACITY = 16;
const INITIAL_SPARSE_CAPACITY = 64;
const EMPTY_ROW = -1;

//=========================================================
// ArchetypeID
//=========================================================

export type ArchetypeID = Brand<number, "archetype_id">;

export const as_archetype_id = (value: number) =>
  validate_and_cast<number, ArchetypeID>(
    value,
    (v) => Number.isInteger(v) && v >= 0,
    "ArchetypeID must be a non-negative integer",
  );

//=========================================================
// ArchetypeEdge
//=========================================================

export interface ArchetypeEdge {
  add: ArchetypeID | null;
  remove: ArchetypeID | null;
}

//=========================================================
// Binary search on sorted ComponentID array
//=========================================================

// TODO: Move this to util
function binary_search(
  sorted: readonly ComponentID[],
  target: ComponentID,
): number {
  let lo = 0;
  let hi = sorted.length - 1;
  const tgt = target as number;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const val = sorted[mid] as number;
    if (val === tgt) return mid;
    if (val < tgt) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

//=========================================================
// Archetype
//=========================================================

export class Archetype {
  readonly id: ArchetypeID;
  readonly signature: readonly ComponentID[];

  private entity_ids: Uint32Array;
  private index_to_row: Int32Array;
  private len: number = 0;
  private edges: Map<ComponentID, ArchetypeEdge> = new Map();

  /**
   * @param id - Archetype identifier
   * @param sorted_signature - Pre-sorted array of ComponentIDs (caller must sort)
   */
  constructor(id: ArchetypeID, sorted_signature: readonly ComponentID[]) {
    this.id = id;
    this.signature = Object.freeze(sorted_signature);
    this.entity_ids = new Uint32Array(INITIAL_DENSE_CAPACITY);
    this.index_to_row = new Int32Array(INITIAL_SPARSE_CAPACITY).fill(EMPTY_ROW);
  }

  //=========================================================
  // Queries
  //=========================================================

  public get entity_count(): number {
    return this.len;
  }

  public get entity_list(): Uint32Array {
    return this.entity_ids.subarray(0, this.len);
  }

  public has_component(id: ComponentID): boolean {
    return binary_search(this.signature, id) !== -1;
  }

  /** Check if this archetype's signature is a superset of `required`. */
  public matches(required: readonly ComponentID[]): boolean {
    for (let i = 0; i < required.length; i++) {
      if (binary_search(this.signature, required[i]) === -1) return false;
    }
    return true;
  }

  public has_entity(entity_index: number): boolean {
    return (
      entity_index < this.index_to_row.length &&
      this.index_to_row[entity_index] !== EMPTY_ROW
    );
  }

  //=========================================================
  // Membership (called by Store only)
  //=========================================================

  public add_entity(entity_id: EntityID, entity_index: number): void {
    if (this.len >= this.entity_ids.length) this.grow_entity_ids();
    if (entity_index >= this.index_to_row.length)
      this.grow_index_to_row(entity_index + 1);

    const row = this.len;
    this.entity_ids[row] = entity_id as number;
    this.index_to_row[entity_index] = row;
    this.len++;
  }

  /**
   * Remove an entity by its index using swap-and-pop.
   *
   * Returns the entity_index of the entity that was swapped into the
   * removed slot, or -1 if the removed entity was the last element
   * (no swap needed).
   */
  public remove_entity(entity_index: number): number {
    if (__DEV__) {
      if (
        entity_index >= this.index_to_row.length ||
        this.index_to_row[entity_index] === EMPTY_ROW
      ) {
        throw new ECSError(
          ECS_ERROR.ENTITY_NOT_IN_ARCHETYPE,
          `Entity index ${entity_index} is not in archetype ${this.id}`,
        );
      }
    }

    const row = this.index_to_row[entity_index];
    const last_row = this.len - 1;

    this.index_to_row[entity_index] = EMPTY_ROW;

    if (row !== last_row) {
      this.entity_ids[row] = this.entity_ids[last_row];
      const swapped_index = get_entity_index(this.entity_ids[row] as EntityID);
      this.index_to_row[swapped_index] = row;
      this.len--;
      return swapped_index;
    }

    this.len--;
    return -1;
  }

  //=========================================================
  // Growth helpers
  //=========================================================

  private grow_entity_ids(): void {
    const next = new Uint32Array(this.entity_ids.length * 2);
    next.set(this.entity_ids);
    this.entity_ids = next;
  }

  private grow_index_to_row(min_capacity: number): void {
    let cap = this.index_to_row.length;
    while (cap < min_capacity) cap *= 2;
    const next = new Int32Array(cap).fill(EMPTY_ROW);
    next.set(this.index_to_row);
    this.index_to_row = next;
  }

  //=========================================================
  // Graph edges (called by Store only)
  //=========================================================

  public get_edge(component_id: ComponentID): ArchetypeEdge | undefined {
    return this.edges.get(component_id);
  }

  public set_edge(component_id: ComponentID, edge: ArchetypeEdge): void {
    this.edges.set(component_id, edge);
  }
}
