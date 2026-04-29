/***
 * Component — Schema definition and phantom-typed handles.
 *
 * Components are defined as records mapping field names to typed array tags:
 *
 *   const Pos = world.register_component({ x: "f64", y: "f64" });
 *   const Health = world.register_component({ current: "i32", max: "i32" });
 *
 * Or via array shorthand (defaults to "f64"):
 *
 *   const Vel = world.register_component(["vx", "vy"] as const);
 *
 * At runtime, a ComponentDef<S> is just a ComponentID (branded number).
 * The generic S is erased but carried at compile-time, enabling
 * type-safe column access: arch.get_column(Pos, "x") returns Float64Array,
 * arch.get_column(Health, "current") returns Int32Array.
 *
 * Tag components (empty schema) participate in archetype matching
 * but store no data:
 *
 *   const IsEnemy = world.register_tag();
 *   world.add_component(e, IsEnemy);    // no values needed
 *
 ***/

import {
  Brand,
  validate_and_cast,
  is_non_negative_integer,
  type TypedArrayTag,
} from "./type_primitives";

export type ComponentID = Brand<number, "component_id">;
export const as_component_id = (value: number) =>
  validate_and_cast<number, ComponentID>(
    value,
    is_non_negative_integer,
    "ComponentID must be a non-negative integer",
  );

/**
 * Core component schema — maps field names to {@link TagToTypedArray | typed array tags}.
 *
 * Used as the type parameter of {@link ComponentDef}. Each field becomes
 * a column in the archetype's SoA layout, backed by the typed array
 * indicated by its tag.
 */
export type ComponentSchema = Readonly<Record<string, TypedArrayTag>>;

/**
 * Compile-time mapping from typed-array tag to the corresponding TypedArray
 * constructor. Drives the static type of {@link ColumnsForSchema}.
 */
export type TagToTypedArray = {
  /** 32-bit float column. */
  f32: Float32Array;
  /** 64-bit float column (default). */
  f64: Float64Array;
  /** 8-bit signed integer column. */
  i8: Int8Array;
  /** 16-bit signed integer column. */
  i16: Int16Array;
  /** 32-bit signed integer column. */
  i32: Int32Array;
  /** 8-bit unsigned integer column. */
  u8: Uint8Array;
  /** 16-bit unsigned integer column. */
  u16: Uint16Array;
  /** 32-bit unsigned integer column. */
  u32: Uint32Array;
};

/**
 * The plain-object shape passed when adding a component, e.g.
 * `{ x: 0, y: 0 }` for `ComponentDef<{ x: "f64", y: "f64" }>`. Every field
 * in the schema is required.
 */
export type FieldValues<S extends ComponentSchema> = {
  readonly [K in keyof S]: number;
};

/**
 * The static shape of an archetype's column group for a given schema:
 * each field becomes the typed array indicated by its tag. Returned by
 * `archetype.get_column(Def, ...)` when iterating.
 */
export type ColumnsForSchema<S extends ComponentSchema> = {
  readonly [K in keyof S]: TagToTypedArray[S[K]];
};

/**
 * A component's field-name list — used by event channels and other
 * field-oriented APIs. A readonly tuple of strings.
 */
export type ComponentFields = readonly string[];

/** Maps component fields to column arrays (used by events — always Float64Array). */
export type ColumnsForFields<F extends ComponentFields> = {
  readonly [K in F[number]]: Float64Array;
};

// Phantom symbol — never exists at runtime, only provides a type-level slot
// for the field schema S so that ComponentDef<{x:"f64",y:"f64"}> and
// ComponentDef<{vx:"f64",vy:"f64"}> are distinct types even though both
// are just branded numbers.
declare const __schema: unique symbol;

/**
 * A registered component's handle — at runtime a branded number (the
 * component ID), at compile time it carries the component's
 * {@link ComponentSchema} as a phantom type.
 *
 * Returned by {@link ECS.register_component} and
 * {@link ECS.register_tag}. Pass to {@link ECS.add_component},
 * {@link Query} composition, etc. Two different components with the same
 * field shape are still distinct types — identity is by registration, not
 * structural shape.
 */
export type ComponentDef<S extends ComponentSchema = ComponentSchema> = ComponentID & {
  readonly [__schema]: S;
};

/**
 * Compile-time read-only view of a typed-array column. Indexed access
 * returns `number`; assignment is a type error.
 */
export interface ReadonlyColumn {
  readonly [index: number]: number;
  readonly length: number;
}

/**
 * Compile-time read-only view of a `Uint32Array`. Indexed access returns
 * `number`; assignment is a type error.
 */
export interface ReadonlyUint32Array {
  readonly [index: number]: number;
  readonly length: number;
}
