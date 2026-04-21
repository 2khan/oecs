/***
 * Event — Typed event channels with SoA storage.
 *
 * Events are fire-and-forget messages that systems emit within a frame
 * and other systems can read during the same frame. They are auto-cleared
 * at the end of each update cycle (after all phases have run).
 *
 * Events use SoA (Structure of Arrays) layout matching the component
 * pattern: each field is a separate number[] column, and a shared reader
 * object exposes named field arrays plus a length property.
 *
 * Signals are zero-field events — they carry no payload, just a count
 * of how many times they were emitted.
 *
 * Events are identified by module-scope EventKey symbols, analogous
 * to ResourceKey. Register once, import the key anywhere:
 *
 *   // definition (module scope)
 *   export const DamageEvent = event_key<readonly ["target", "amount"]>("Damage");
 *
 *   // registration (plugin/setup)
 *   world.register_event(DamageEvent, ["target", "amount"] as const);
 *
 *   // usage (system)
 *   ctx.emit(DamageEvent, { target: entityId, amount: 50 });
 *   const dmg = ctx.read(DamageEvent);
 *   for (let i = 0; i < dmg.length; i++) { ... }
 *
 ***/

import { Brand, validate_and_cast, is_non_negative_integer, unsafe_cast } from "./type_primitives";
import type { ComponentFields, ColumnsForFields } from "./component";

export type EventID = Brand<number, "event_id">;
export const as_event_id = (value: number) =>
  validate_and_cast<number, EventID>(
    value,
    is_non_negative_integer,
    "EventID must be a non-negative integer",
  );

// Phantom symbol for the field schema — never exists at runtime.
declare const __event_schema: unique symbol;

export type EventDef<F extends ComponentFields = ComponentFields> = EventID & {
  readonly [__event_schema]: F;
};

/** Reader view over an event channel's SoA columns. */
export type EventReader<F extends ComponentFields> = {
  length: number;
} & ColumnsForFields<F>;

export class EventChannel {
  public readonly field_names: string[];
  public readonly columns: number[][];
  // any: type-erased storage — channel is stored in Map<number, EventChannel>, F is lost
  public readonly reader: EventReader<any>;

  constructor(field_names: string[]) {
    this.field_names = field_names;
    this.columns = [];
    for (let i = 0; i < field_names.length; i++) {
      this.columns.push([]);
    }

    // Build the reader object: { length: 0, [field]: columns[i] }
    // any: partially-constructed EventReader<F> — dynamically assigned columns become mapped type
    const reader: any = { length: 0 };
    for (let i = 0; i < field_names.length; i++) {
      reader[field_names[i]] = this.columns[i];
    }
    this.reader = reader;
  }

  public emit(values: Record<string, number>): void {
    const names = this.field_names;
    const cols = this.columns;
    for (let i = 0; i < names.length; i++) {
      cols[i].push(values[names[i]]);
    }
    this.reader.length++;
  }

  /** Emit a signal (zero-field event). */
  public emit_signal(): void {
    this.reader.length++;
  }

  public clear(): void {
    this.reader.length = 0;
    const cols = this.columns;
    for (let i = 0; i < cols.length; i++) {
      cols[i].length = 0;
    }
  }
}

// =======================================================
// Event keys — module-scope symbol handles for events
// =======================================================

declare const __event_key_schema: unique symbol;

export type EventKey<F extends ComponentFields = ComponentFields> = symbol & {
  readonly [__event_key_schema]: F;
};

export function event_key<F extends readonly string[]>(name: string): EventKey<F> {
  return unsafe_cast<EventKey<F>>(Symbol(name));
}

export function signal_key(name: string): EventKey<readonly []> {
  return unsafe_cast<EventKey<readonly []>>(Symbol(name));
}
