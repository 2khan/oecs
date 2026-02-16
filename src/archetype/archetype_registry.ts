/***
 *
 * ArchetypeRegistry - Manages archetype creation, deduplication, and transitions
 *
 * Owns the archetype dense array, signature dedup map, graph edge
 * resolution, and component index (for query matching).
 *
 * Store delegates all archetype operations here, keeping itself as a
 * pure orchestrator of registries.
 *
 ***/

import type { ComponentID } from "../component/component";
import {
  Archetype,
  as_archetype_id,
  type ArchetypeID,
} from "./archetype";
import { ECS_ERROR, ECSError } from "../utils/error";

//=========================================================
// ArchetypeRegistry
//=========================================================

export class ArchetypeRegistry {
  private archetypes: Archetype[] = [];
  private archetype_map: Map<number, ArchetypeID[]> = new Map();
  private next_archetype_id = 0;

  // Component index: ComponentID → Set<ArchetypeID>
  private component_index: Map<ComponentID, Set<ArchetypeID>> = new Map();

  // The empty archetype (no components)
  private _empty_archetype_id: ArchetypeID;

  constructor() {
    this._empty_archetype_id = this.get_or_create([]);
  }

  //=========================================================
  // Queries
  //=========================================================

  get count(): number {
    return this.archetypes.length;
  }

  get empty_archetype_id(): ArchetypeID {
    return this._empty_archetype_id;
  }

  get(id: ArchetypeID): Archetype {
    if (__DEV__) {
      if ((id as number) < 0 || (id as number) >= this.archetypes.length) {
        throw new ECSError(
          ECS_ERROR.ARCHETYPE_NOT_FOUND,
          `Archetype with ID ${id} not found`,
        );
      }
    }
    return this.archetypes[id];
  }

  /** Number of archetypes containing a given component. */
  get_component_archetype_count(id: ComponentID): number {
    return this.component_index.get(id)?.size ?? 0;
  }

  /**
   * Find all archetypes whose signature is a superset of `required`.
   *
   * Uses component_index intersection with smallest-set-first optimization.
   */
  get_matching(required: readonly ComponentID[]): readonly Archetype[] {
    if (required.length === 0) {
      return this.archetypes.slice();
    }

    // Find the component with the fewest archetypes (smallest set)
    let smallest_set: Set<ArchetypeID> | undefined;
    for (const component_id of required) {
      const set = this.component_index.get(component_id);
      if (!set || set.size === 0) return [];
      if (!smallest_set || set.size < smallest_set.size) {
        smallest_set = set;
      }
    }

    // Intersect: start with smallest set, filter by matches
    const result: Archetype[] = [];
    for (const archetype_id of smallest_set!) {
      const arch = this.get(archetype_id);
      if (arch.matches(required)) {
        result.push(arch);
      }
    }

    return result;
  }

  //=========================================================
  // Creation & transitions
  //=========================================================

  get_or_create(signature: readonly ComponentID[]): ArchetypeID {
    const sorted = [...signature].sort((a, b) => a - b);
    return this.get_or_create_sorted(sorted);
  }

  private get_or_create_sorted(sorted: readonly ComponentID[]): ArchetypeID {
    const hash = this.hash_signature(sorted);

    const bucket = this.archetype_map.get(hash);
    if (bucket !== undefined) {
      for (let i = 0; i < bucket.length; i++) {
        if (this.signatures_equal(this.archetypes[bucket[i]].signature, sorted)) {
          return bucket[i];
        }
      }
    }

    const id = as_archetype_id(this.next_archetype_id++);
    const archetype = new Archetype(id, sorted);

    this.archetypes.push(archetype);
    if (bucket !== undefined) {
      bucket.push(id);
    } else {
      this.archetype_map.set(hash, [id]);
    }

    // Update component index
    for (let i = 0; i < sorted.length; i++) {
      const component_id = sorted[i];
      let set = this.component_index.get(component_id);
      if (!set) {
        set = new Set();
        this.component_index.set(component_id, set);
      }
      set.add(id);
    }

    return id;
  }

  resolve_add(archetype_id: ArchetypeID, component_id: ComponentID): ArchetypeID {
    const current = this.get(archetype_id);

    // Already has this component — no transition needed
    if (current.has_component(component_id)) return archetype_id;

    // Check cached edge
    const edge = current.get_edge(component_id);
    if (edge?.add != null) return edge.add;

    // Cache miss: build sorted signature via sorted insertion
    // current.signature is already sorted, insert component_id in order
    const target_id = this.get_or_create_sorted(
      this.sorted_insert(current.signature, component_id),
    );

    // Cache bidirectional edges
    this.cache_edge(current, this.get(target_id), component_id);

    return target_id;
  }

  resolve_remove(archetype_id: ArchetypeID, component_id: ComponentID): ArchetypeID {
    const current = this.get(archetype_id);

    // Doesn't have this component — no transition needed
    if (!current.has_component(component_id)) return archetype_id;

    // Check cached edge
    const edge = current.get_edge(component_id);
    if (edge?.remove != null) return edge.remove;

    // Cache miss: filter produces a sorted result since source is sorted
    const new_sig = current.signature.filter((c) => c !== component_id);
    const target_id = this.get_or_create_sorted(new_sig);

    // Cache bidirectional edges (reversed: target --add--> current, current --remove--> target)
    this.cache_edge(this.get(target_id), current, component_id);

    return target_id;
  }

  //=========================================================
  // Internal
  //=========================================================

  private cache_edge(
    from: Archetype,
    to: Archetype,
    component_id: ComponentID,
  ): void {
    // Forward edge: from --add component_id--> to
    const from_edge = from.get_edge(component_id) ?? {
      add: null,
      remove: null,
    };
    from_edge.add = to.id;
    from.set_edge(component_id, from_edge);

    // Reverse edge: to --remove component_id--> from
    const to_edge = to.get_edge(component_id) ?? {
      add: null,
      remove: null,
    };
    to_edge.remove = from.id;
    to.set_edge(component_id, to_edge);
  }

  /** Insert a component ID into an already-sorted signature, maintaining sort order. */
  private sorted_insert(
    sorted: readonly ComponentID[],
    id: ComponentID,
  ): ComponentID[] {
    const result = new Array<ComponentID>(sorted.length + 1);
    let inserted = false;
    let j = 0;
    for (let i = 0; i < sorted.length; i++) {
      if (!inserted && (id as number) < (sorted[i] as number)) {
        result[j++] = id;
        inserted = true;
      }
      result[j++] = sorted[i];
    }
    if (!inserted) {
      result[j] = id;
    }
    return result;
  }

  /** FNV-1a hash over a sorted ComponentID array. Zero allocation. */
  private hash_signature(sig: readonly ComponentID[]): number {
    let h = 0x811c9dc5; // FNV offset basis (32-bit)
    for (let i = 0; i < sig.length; i++) {
      h ^= sig[i] as number;
      h = Math.imul(h, 0x01000193); // FNV prime (32-bit)
    }
    return h;
  }

  /** Compare two sorted ComponentID arrays for equality. */
  private signatures_equal(
    a: readonly ComponentID[],
    b: readonly ComponentID[],
  ): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }
}
