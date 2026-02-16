export type TypeTag =
  | "f32"
  | "f64"
  | "u8"
  | "u16"
  | "u32"
  | "i8"
  | "i16"
  | "i32";

export type TypedArray =
  | Float32Array
  | Float64Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

export type TypedArrayConstructor =
  | Float32ArrayConstructor
  | Float64ArrayConstructor
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int8ArrayConstructor
  | Int16ArrayConstructor
  | Int32ArrayConstructor;

export const TYPED_ARRAY_MAP = {
  f32: Float32Array,
  f64: Float64Array,
  u8: Uint8Array,
  u16: Uint16Array,
  u32: Uint32Array,
  i8: Int8Array,
  i16: Int16Array,
  i32: Int32Array,
} as const satisfies Record<TypeTag, TypedArrayConstructor>;

export type TypedArrayFor<T extends TypeTag> = InstanceType<
  (typeof TYPED_ARRAY_MAP)[T]
>;
