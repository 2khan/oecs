/***
 *
 * Schedule - System execution lifecycle management
 *
 * Systems are grouped into 6 phases (3 startup, 3 update). Within
 * each phase, systems are topologically sorted based on before/after
 * ordering constraints. The sorted order is cached and invalidated
 * when systems are added or removed.
 *
 * Uses Kahn's algorithm with a binary min-heap for O((V+E) log V)
 * topological sort (the old implementation re-sorted an array on
 * every insert, which was O(V² log V)).
 *
 ***/

import type { SystemContext } from "../query/query";
import type { SystemDescriptor } from "../system/system";
import { ECS_ERROR, ECSError } from "../utils/error";

//=========================================================
// Schedule phases
//=========================================================

export enum SCHEDULE {
  PRE_STARTUP = "PRE_STARTUP",
  STARTUP = "STARTUP",
  POST_STARTUP = "POST_STARTUP",
  PRE_UPDATE = "PRE_UPDATE",
  UPDATE = "UPDATE",
  POST_UPDATE = "POST_UPDATE",
}

const STARTUP_LABELS = [
  SCHEDULE.PRE_STARTUP,
  SCHEDULE.STARTUP,
  SCHEDULE.POST_STARTUP,
] as const;

const UPDATE_LABELS = [
  SCHEDULE.PRE_UPDATE,
  SCHEDULE.UPDATE,
  SCHEDULE.POST_UPDATE,
] as const;

//=========================================================
// Ordering constraints
//=========================================================

export interface SystemOrdering {
  before?: SystemDescriptor[];
  after?: SystemDescriptor[];
}

export interface SystemEntry {
  system: SystemDescriptor;
  ordering?: SystemOrdering;
}

//=========================================================
// Internal node
//=========================================================

interface SystemNode {
  descriptor: SystemDescriptor;
  insertion_order: number;
  before: Set<SystemDescriptor>;
  after: Set<SystemDescriptor>;
}

//=========================================================
// Min-heap (keyed by insertion order)
//=========================================================

class MinHeap {
  private data: SystemDescriptor[] = [];
  private order_map: Map<SystemDescriptor, number>;

  constructor(order_map: Map<SystemDescriptor, number>) {
    this.order_map = order_map;
  }

  get size(): number {
    return this.data.length;
  }

  push(item: SystemDescriptor): void {
    this.data.push(item);
    this.sift_up(this.data.length - 1);
  }

  pop(): SystemDescriptor | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sift_down(0);
    }
    return top;
  }

  private key(item: SystemDescriptor): number {
    return this.order_map.get(item)!;
  }

  private sift_up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.key(this.data[i]) < this.key(this.data[parent])) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  private sift_down(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (
        left < n &&
        this.key(this.data[left]) < this.key(this.data[smallest])
      ) {
        smallest = left;
      }
      if (
        right < n &&
        this.key(this.data[right]) < this.key(this.data[smallest])
      ) {
        smallest = right;
      }

      if (smallest !== i) {
        this.swap(i, smallest);
        i = smallest;
      } else {
        break;
      }
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.data[a];
    this.data[a] = this.data[b];
    this.data[b] = tmp;
  }
}

//=========================================================
// Schedule
//=========================================================

export class Schedule {
  private label_systems: Map<SCHEDULE, SystemNode[]> = new Map();
  private sorted_cache: Map<SCHEDULE, SystemDescriptor[]> = new Map();
  private system_index: Map<SystemDescriptor, SCHEDULE> = new Map();
  private next_insertion_order = 0;

  constructor() {
    for (let i = 0; i < STARTUP_LABELS.length; i++) {
      this.label_systems.set(STARTUP_LABELS[i], []);
    }
    for (let i = 0; i < UPDATE_LABELS.length; i++) {
      this.label_systems.set(UPDATE_LABELS[i], []);
    }
  }

  /**
   * Register one or more systems under a schedule phase.
   * Accepts bare SystemDescriptors or SystemEntry objects for ordering.
   */
  add_systems(
    label: SCHEDULE,
    ...entries: (SystemDescriptor | SystemEntry)[]
  ): void {
    for (const entry of entries) {
      const { descriptor, ordering } = this.normalize_entry(entry);

      if (__DEV__) {
        if (this.system_index.has(descriptor)) {
          throw new ECSError(
            ECS_ERROR.DUPLICATE_SYSTEM,
            `System ${descriptor.id} is already scheduled`,
          );
        }
      }

      const node: SystemNode = {
        descriptor,
        insertion_order: this.next_insertion_order++,
        before: new Set(ordering?.before ?? []),
        after: new Set(ordering?.after ?? []),
      };

      this.label_systems.get(label)!.push(node);
      this.system_index.set(descriptor, label);
      this.sorted_cache.delete(label);
    }
  }

  /**
   * Remove a system from the schedule.
   * Does NOT call lifecycle hooks - that is SystemRegistry's job.
   */
  remove_system(system: SystemDescriptor): void {
    const label = this.system_index.get(system);
    if (label === undefined) return;

    const nodes = this.label_systems.get(label)!;
    const index = nodes.findIndex((n) => n.descriptor === system);
    if (index !== -1) {
      const last = nodes.length - 1;
      if (index !== last) {
        nodes[index] = nodes[last];
      }
      nodes.pop();

      // Clean up dangling ordering references from remaining nodes
      for (const node of nodes) {
        node.before.delete(system);
        node.after.delete(system);
      }
    }

    this.system_index.delete(system);
    this.sorted_cache.delete(label);
  }

  /**
   * Run all startup phases in order: PRE_STARTUP -> STARTUP -> POST_STARTUP
   */
  run_startup(ctx: SystemContext): void {
    for (const label of STARTUP_LABELS) {
      this.run_label(label, ctx, 0);
    }
  }

  /**
   * Run all update phases in order: PRE_UPDATE -> UPDATE -> POST_UPDATE
   */
  run_update(ctx: SystemContext, delta_time: number): void {
    for (const label of UPDATE_LABELS) {
      this.run_label(label, ctx, delta_time);
    }
  }

  /**
   * Get all systems across all phases.
   */
  get_all_systems(): SystemDescriptor[] {
    const all: SystemDescriptor[] = [];
    for (const nodes of this.label_systems.values()) {
      for (const node of nodes) {
        all.push(node.descriptor);
      }
    }
    return all;
  }

  /**
   * Check if a system descriptor is scheduled.
   */
  has_system(system: SystemDescriptor): boolean {
    return this.system_index.has(system);
  }

  /**
   * Clear all systems from the schedule.
   * Does NOT call lifecycle hooks - that is SystemRegistry's job.
   */
  clear(): void {
    for (const nodes of this.label_systems.values()) {
      nodes.length = 0;
    }
    this.sorted_cache.clear();
    this.system_index.clear();
  }

  //=========================================================
  // Private
  //=========================================================

  private run_label(
    label: SCHEDULE,
    ctx: SystemContext,
    delta_time: number,
  ): void {
    const sorted = this.get_sorted(label);
    for (let i = 0; i < sorted.length; i++) {
      sorted[i].fn(ctx, delta_time);
    }
    ctx.flush();
  }

  private get_sorted(label: SCHEDULE): SystemDescriptor[] {
    const cached = this.sorted_cache.get(label);
    if (cached !== undefined) return cached;

    const nodes = this.label_systems.get(label)!;
    const sorted = this.topological_sort(nodes, label);
    this.sorted_cache.set(label, sorted);
    return sorted;
  }

  /**
   * Topological sort using Kahn's algorithm with min-heap.
   *
   * Uses insertion order as tiebreaker for deterministic output.
   * Throws on circular dependencies.
   */
  private topological_sort(
    nodes: SystemNode[],
    label: SCHEDULE,
  ): SystemDescriptor[] {
    if (nodes.length === 0) return [];

    // Build adjacency list and in-degree count
    // Edge: A -> B means "A runs before B"
    const adjacency = new Map<SystemDescriptor, Set<SystemDescriptor>>();
    const in_degree = new Map<SystemDescriptor, number>();
    const insertion_order = new Map<SystemDescriptor, number>();
    const node_set = new Set<SystemDescriptor>();

    for (const node of nodes) {
      adjacency.set(node.descriptor, new Set());
      in_degree.set(node.descriptor, 0);
      insertion_order.set(node.descriptor, node.insertion_order);
      node_set.add(node.descriptor);
    }

    for (const node of nodes) {
      // "this system runs before X" -> edge: this -> X
      for (const target of node.before) {
        if (!node_set.has(target)) continue;
        adjacency.get(node.descriptor)!.add(target);
        in_degree.set(target, in_degree.get(target)! + 1);
      }

      // "this system runs after X" -> edge: X -> this
      for (const dep of node.after) {
        if (!node_set.has(dep)) continue;
        adjacency.get(dep)!.add(node.descriptor);
        in_degree.set(node.descriptor, in_degree.get(node.descriptor)! + 1);
      }
    }

    // Kahn's algorithm with min-heap (keyed by insertion order)
    const heap = new MinHeap(insertion_order);

    for (const node of nodes) {
      if (in_degree.get(node.descriptor) === 0) {
        heap.push(node.descriptor);
      }
    }

    const result: SystemDescriptor[] = [];

    while (heap.size > 0) {
      const current = heap.pop()!;
      result.push(current);

      for (const neighbor of adjacency.get(current)!) {
        const new_degree = in_degree.get(neighbor)! - 1;
        in_degree.set(neighbor, new_degree);
        if (new_degree === 0) {
          heap.push(neighbor);
        }
      }
    }

    // Cycle detection
    if (result.length !== nodes.length) {
      const result_set = new Set(result);
      const remaining = nodes
        .filter((n) => !result_set.has(n.descriptor))
        .map((n) => `system_${n.descriptor.id}`);

      throw new ECSError(
        ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY,
        `Circular system dependency detected in ${label}: [${remaining.join(", ")}]`,
      );
    }

    return result;
  }

  private normalize_entry(entry: SystemDescriptor | SystemEntry): {
    descriptor: SystemDescriptor;
    ordering?: SystemOrdering;
  } {
    if ("system" in entry) {
      return { descriptor: entry.system, ordering: entry.ordering };
    }
    return { descriptor: entry };
  }
}
