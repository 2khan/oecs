/***
 * Schedule — System execution lifecycle with topological ordering.
 *
 * Systems are organized into 7 phases:
 *   PRE_STARTUP  → STARTUP → POST_STARTUP  (run once via world.startup())
 *   FIXED_UPDATE                            (run at fixed timestep via world.update(dt))
 *   PRE_UPDATE   → UPDATE  → POST_UPDATE   (run every frame via world.update(dt))
 *
 * Within each phase, systems are topologically sorted using Kahn's
 * algorithm, respecting before/after ordering constraints. Insertion
 * order is used as a stable tiebreaker for deterministic execution.
 *
 * After all systems in a phase complete, SystemContext.flush() is called
 * automatically, applying deferred structural changes before the next phase.
 *
 * The sort result is cached per phase and invalidated when systems are
 * added or removed.
 *
 * Usage:
 *
 *   world.add_systems(SCHEDULE.UPDATE, moveSys, {
 *     system: renderSys,
 *     ordering: { after: [moveSys] },
 *   });
 *
 ***/

import { topological_sort } from "./type_primitives";
import type { SystemContext } from "./query";
import type { SystemDescriptor } from "./system";
import { ECS_ERROR, ECSError } from "./utils/error";
import { STARTUP_DELTA_TIME } from "./utils/constants";

export enum SCHEDULE {
  PRE_STARTUP = "PRE_STARTUP",
  STARTUP = "STARTUP",
  POST_STARTUP = "POST_STARTUP",
  FIXED_UPDATE = "FIXED_UPDATE",
  PRE_UPDATE = "PRE_UPDATE",
  UPDATE = "UPDATE",
  POST_UPDATE = "POST_UPDATE",
}

const STARTUP_LABELS = [SCHEDULE.PRE_STARTUP, SCHEDULE.STARTUP, SCHEDULE.POST_STARTUP] as const;

const UPDATE_LABELS = [SCHEDULE.PRE_UPDATE, SCHEDULE.UPDATE, SCHEDULE.POST_UPDATE] as const;

export interface SystemOrdering {
  before?: SystemDescriptor[];
  after?: SystemDescriptor[];
}

export interface SystemEntry {
  system: SystemDescriptor;
  ordering?: SystemOrdering;
}

interface SystemNode {
  descriptor: SystemDescriptor;
  insertion_order: number;
  before: Set<SystemDescriptor>;
  after: Set<SystemDescriptor>;
}

export class Schedule {
  private readonly label_systems: Map<SCHEDULE, SystemNode[]> = new Map();
  private readonly sorted_cache: Map<SCHEDULE, SystemDescriptor[]> = new Map();
  private readonly system_index: Map<SystemDescriptor, SCHEDULE> = new Map();
  private readonly system_last_run: Map<SystemDescriptor, number> = new Map();
  private next_insertion_order = 0;

  constructor() {
    for (let i = 0; i < STARTUP_LABELS.length; i++) {
      this.label_systems.set(STARTUP_LABELS[i], []);
    }
    this.label_systems.set(SCHEDULE.FIXED_UPDATE, []);
    for (let i = 0; i < UPDATE_LABELS.length; i++) {
      this.label_systems.set(UPDATE_LABELS[i], []);
    }
  }

  public add_systems(label: SCHEDULE, ...entries: (SystemDescriptor | SystemEntry)[]): void {
    for (const entry of entries) {
      const descriptor = "system" in entry ? entry.system : entry;
      const ordering = "system" in entry ? entry.ordering : undefined;

      if (__DEV__) {
        if (this.system_index.has(descriptor)) {
          throw new ECSError(
            ECS_ERROR.DUPLICATE_SYSTEM,
            `System ${descriptor.name ?? descriptor.id} is already scheduled`,
          );
        }
      }

      const node: SystemNode = {
        descriptor,
        insertion_order: this.next_insertion_order++,
        before: new Set(ordering?.before ?? []),
        after: new Set(ordering?.after ?? []),
      };

      // ! safe: constructor pre-populates all SCHEDULE enum keys
      this.label_systems.get(label)!.push(node);
      this.system_index.set(descriptor, label);
      this.system_last_run.set(descriptor, 0);
      this.sorted_cache.delete(label);
    }
  }

  public remove_system(system: SystemDescriptor): void {
    const label = this.system_index.get(system);
    if (label === undefined) return;

    // ! safe: label came from system_index which only stores valid SCHEDULE keys
    const nodes = this.label_systems.get(label)!;
    const index = nodes.findIndex((n) => n.descriptor === system);
    if (index !== -1) {
      // Swap-and-pop removal
      const last = nodes.length - 1;
      if (index !== last) {
        nodes[index] = nodes[last];
      }
      nodes.pop();

      // Clean up ordering references from remaining nodes
      for (const node of nodes) {
        node.before.delete(system);
        node.after.delete(system);
      }
    }

    this.system_index.delete(system);
    this.system_last_run.delete(system);
    this.sorted_cache.delete(label);
  }

  public run_startup(ctx: SystemContext, tick: number): void {
    for (const label of STARTUP_LABELS) {
      this.run_label(label, ctx, STARTUP_DELTA_TIME, tick);
    }
  }

  public run_update(ctx: SystemContext, delta_time: number, tick: number): void {
    for (const label of UPDATE_LABELS) {
      this.run_label(label, ctx, delta_time, tick);
    }
  }

  public run_fixed_update(ctx: SystemContext, fixed_dt: number, tick: number): void {
    this.run_label(SCHEDULE.FIXED_UPDATE, ctx, fixed_dt, tick);
  }

  public has_fixed_systems(): boolean {
    // ! safe: constructor pre-populates all SCHEDULE enum keys
    return this.label_systems.get(SCHEDULE.FIXED_UPDATE)!.length > 0;
  }

  public get_all_systems(): SystemDescriptor[] {
    const all: SystemDescriptor[] = [];
    for (const nodes of this.label_systems.values()) {
      for (const node of nodes) {
        all.push(node.descriptor);
      }
    }
    return all;
  }

  public has_system(system: SystemDescriptor): boolean {
    return this.system_index.has(system);
  }

  public clear(): void {
    for (const nodes of this.label_systems.values()) {
      nodes.length = 0;
    }
    this.sorted_cache.clear();
    this.system_index.clear();
    this.system_last_run.clear();
  }

  private run_label(label: SCHEDULE, ctx: SystemContext, delta_time: number, tick: number): void {
    const sorted = this.get_sorted(label);
    for (let i = 0; i < sorted.length; i++) {
      this.system_last_run.set(sorted[i], tick);
      ctx.last_run_tick = tick;
      sorted[i].fn(ctx, delta_time);
    }
    // Flush deferred changes after each phase so the next phase sees a consistent state
    ctx.flush();
  }

  private get_sorted(label: SCHEDULE): SystemDescriptor[] {
    const cached = this.sorted_cache.get(label);
    if (cached !== undefined) return cached;

    // ! safe: constructor pre-populates all SCHEDULE enum keys
    const nodes = this.label_systems.get(label)!;
    const sorted = this.sort_systems(nodes, label);
    this.sorted_cache.set(label, sorted);
    return sorted;
  }

  /**
   * Delegates to the shared topological_sort utility.
   * Builds the dependency edge map from before/after constraints, then
   * catches any cycle TypeError and re-throws as ECSError.
   */
  private sort_systems(nodes: SystemNode[], label: SCHEDULE): SystemDescriptor[] {
    if (nodes.length === 0) return [];

    const descriptors: SystemDescriptor[] = [];
    const insertion_order = new Map<SystemDescriptor, number>();
    const node_set = new Set<SystemDescriptor>();

    for (const node of nodes) {
      descriptors.push(node.descriptor);
      insertion_order.set(node.descriptor, node.insertion_order);
      node_set.add(node.descriptor);
    }

    // Build adjacency list: edges.get(a) = list of nodes that must come after a
    const edges = new Map<SystemDescriptor, SystemDescriptor[]>();
    for (const node of nodes) {
      edges.set(node.descriptor, []);
    }

    // ! safe: all descriptors were inserted into edges above;
    // node_set guards skip descriptors from other labels
    for (const node of nodes) {
      // "this system runs before X" → edge: this → X
      for (const target of node.before) {
        if (!node_set.has(target)) continue;
        edges.get(node.descriptor)!.push(target);
      }

      // "this system runs after X" → edge: X → this
      for (const dep of node.after) {
        if (!node_set.has(dep)) continue;
        edges.get(dep)!.push(node.descriptor);
      }
    }

    // ! safe: all descriptors were seeded into insertion_order map above
    const tiebreaker = (a: SystemDescriptor, b: SystemDescriptor) =>
      insertion_order.get(a)! - insertion_order.get(b)!;

    const node_name = (d: SystemDescriptor) => d.name ?? `system_${d.id}`;

    try {
      return topological_sort(descriptors, edges, tiebreaker, node_name);
    } catch (err) {
      if (err instanceof TypeError) {
        throw new ECSError(
          ECS_ERROR.CIRCULAR_SYSTEM_DEPENDENCY,
          `Circular system dependency detected in ${label}: ${err.message}`,
        );
      }
      throw err;
    }
  }
}
