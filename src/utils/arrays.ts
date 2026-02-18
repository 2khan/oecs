/**
 * Grow an Int32Array to hold at least `min_capacity` elements.
 * Doubles from the current length until sufficient, fills new slots
 * with `fill`, and copies existing data into the new buffer.
 */
export function grow_int32_array(
  arr: Int32Array,
  min_capacity: number,
  fill: number,
): Int32Array {
  let cap = arr.length;
  while (cap < min_capacity) cap *= 2;
  const next = new Int32Array(cap).fill(fill);
  next.set(arr);
  return next;
}

/**
 * Push `value` into a hash-bucket map, creating the bucket if absent.
 */
export function bucket_push<T>(
  map: Map<number, T[]>,
  key: number,
  value: T,
): void {
  const bucket = map.get(key);
  if (bucket !== undefined) {
    bucket.push(value);
  } else {
    map.set(key, [value]);
  }
}
