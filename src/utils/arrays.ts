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
