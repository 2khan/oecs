# Type primitives — API reference (v0.2.0)

`type_primitives` is the low-level data-structure and typing layer that the ECS
is built on. It's exported publicly because most of its contents — bit sets,
sparse sets/maps, growable typed arrays, a binary heap, a topological sort, and
a nominal-typing helper — are general-purpose and often useful to library
consumers directly.

All symbols are re-exported from the top-level entry point:

```ts
import {
  BitSet,
  SparseSet,
  SparseMap,
  GrowableFloat32Array,
  TypedArrayFor,
  BinaryHeap,
  topological_sort,
  assert,
  assert_non_null,
  validate_and_cast,
  unsafe_cast,
  is_non_negative_integer,
  is_non_null,
  TYPE_ERROR,
  TypeError,
  type Brand,
  type TypedArrayTag,
  type AnyTypedArray,
  type CompareFn,
} from "@oasys/oecs";
```

## Exports

From `src/type_primitives/index.ts`:

- `./assertions` — `assert`, `assert_non_null`, `validate_and_cast`, `unsafe_cast`, `is_non_negative_integer`, `is_non_null`
- `./brand` — `Brand<T, Name>`
- `./error` — `TYPE_ERROR`, `TypeError`
- `./bitset/bitset` — `BitSet`, `BITS_PER_WORD`, `BITS_PER_WORD_SHIFT`, `BITS_PER_WORD_MASK`, `FNV_OFFSET_BASIS`, `FNV_PRIME`
- `./sparse_set/sparse_set` — `SparseSet`
- `./sparse_map/sparse_map` — `SparseMap<V>`
- `./typed_arrays/typed_arrays` — `GrowableTypedArray<T>`, `GrowableFloat32Array`, `GrowableFloat64Array`, `GrowableInt8Array`, `GrowableInt16Array`, `GrowableInt32Array`, `GrowableUint8Array`, `GrowableUint16Array`, `GrowableUint32Array`, `TypedArrayFor`, `TypedArrayTag`, `AnyTypedArray`, `DEFAULT_INITIAL_CAPACITY`, `GROWTH_FACTOR`
- `./binary_heap/binary_heap` — `BinaryHeap<T>`, `CompareFn<T>`
- `./topological_sort/topological_sort` — `topological_sort`

## BitSet

Auto-growing bit set backed by a `number[]` of 32-bit words. `has`, `set`, and
`clear` are O(1); set-relational checks are O(words).

```ts
new BitSet(words?: number[])

bs.has(bit: number): boolean
bs.set(bit: number): void
bs.clear(bit: number): void

bs.equals(other: BitSet): boolean
bs.contains(other: BitSet): boolean   // superset check
bs.overlaps(other: BitSet): boolean   // non-empty intersection

bs.copy(): BitSet
bs.copy_with_set(bit: number): BitSet
bs.copy_with_clear(bit: number): BitSet

bs.hash(): number                     // FNV-1a over words, trailing-zero-agnostic
bs.for_each(fn: (bit: number) => void): void
```

Backing storage starts at 4 words (128 bits) and doubles as needed.
`equals` and `hash` both ignore trailing zero words, so two logically equal
sets compare and hash equally regardless of whether one has grown more than
the other.

```ts
// from bitset.test.ts
const a = new BitSet();
a.set(0); a.set(3); a.set(31); a.set(32); a.set(64);
const bits: number[] = [];
a.for_each((b) => bits.push(b));
// bits === [0, 3, 31, 32, 64]

const b = a.copy_with_set(200);   // a unchanged
b.has(200); // true
a.has(200); // false
```

### Bit-manipulation and hash constants

Exported alongside the class for consumers who need them directly:

| Constant | Value | Meaning |
| --- | --- | --- |
| `BITS_PER_WORD` | `32` | Word width |
| `BITS_PER_WORD_SHIFT` | `5` | `log2(32)` — used as `bit >>> BITS_PER_WORD_SHIFT` to get word index |
| `BITS_PER_WORD_MASK` | `31` | `32 - 1` — used as `bit & BITS_PER_WORD_MASK` to get bit offset |
| `FNV_OFFSET_BASIS` | `0x811c9dc5` | FNV-1a 32-bit offset basis |
| `FNV_PRIME` | `0x01000193` | FNV-1a 32-bit prime |

## SparseSet

O(1) integer-key set with cache-friendly dense iteration. Stores non-negative
integer keys in a packed `dense` array; a `sparse` array maps each key to its
dense index. Deletion uses swap-and-pop.

```ts
new SparseSet()

s.size: number                        // getter
s.values: readonly number[]           // getter — the dense backing array
s.has(key: number): boolean
s.add(key: number): void              // idempotent
s.delete(key: number): boolean        // returns true if removed
s.clear(): void
s[Symbol.iterator](): Iterator<number>
```

Membership is confirmed by `dense[sparse[key]] === key`, so stale sparse entries
are harmless — no clearing on delete is needed. Iteration visits keys in dense
order.

```ts
// from sparse_set.test.ts
const s = new SparseSet();
s.add(10); s.add(20); s.add(30);
s.delete(10);          // 30 swaps into slot 0
new Set([...s]);       // Set { 20, 30 }
```

## SparseMap\<V\>

Sparse-set-backed map from non-negative integer keys to arbitrary values. Two
parallel dense arrays (keys and values) enable linear iteration; a sparse
array provides O(1) lookup.

```ts
new SparseMap<V>()

m.size: number
m.keys: readonly number[]
m.has(key: number): boolean
m.get(key: number): V | undefined
m.set(key: number, value: V): void    // insert or overwrite
m.delete(key: number): boolean
m.clear(): void
m.for_each(fn: (key: number, value: V) => void): void
m[Symbol.iterator](): Iterator<[number, V]>
```

```ts
// from sparse_map.test.ts
const m = new SparseMap<number>();
m.set(1, 10); m.set(2, 20); m.set(3, 30);
m.delete(2);
m.get(1); // 10
m.get(3); // 30
m.size;   // 2
```

## Typed arrays

`GrowableTypedArray<T>` wraps a fixed-length `TypedArray` with a separate
logical length and a doubling backing buffer, giving amortised O(1) `push`.

```ts
class GrowableTypedArray<T extends AnyTypedArray> {
  constructor(ctor: new (n: number) => T, initial_capacity?: number) // default 16

  readonly length: number
  readonly buf: T                                          // raw backing buffer (may be longer than length)

  push(value: number): void
  pop(): number
  get(i: number): number
  set_at(i: number, value: number): void

  swap_remove(i: number): number                           // returns removed value
  clear(): void

  ensure_capacity(capacity: number): void                  // grows if needed, never shrinks
  bulk_append(src: T, src_offset: number, count: number): void
  bulk_append_zeroes(count: number): void

  view(): T                                                // zero-copy subarray(0, length)
  [Symbol.iterator](): Iterator<number>
}
```

Concrete subclasses provide the right typed-array constructor:

```ts
GrowableFloat32Array   // Float32Array
GrowableFloat64Array   // Float64Array
GrowableInt8Array      // Int8Array
GrowableInt16Array     // Int16Array
GrowableInt32Array     // Int32Array
GrowableUint8Array     // Uint8Array
GrowableUint16Array    // Uint16Array
GrowableUint32Array    // Uint32Array
```

Each default-constructs at capacity `DEFAULT_INITIAL_CAPACITY` (16) and grows
by `GROWTH_FACTOR` (2).

### Tag-based construction

`TypedArrayFor` maps a short string tag to the matching class, useful when
allocating buffers at runtime by a serialised type descriptor:

```ts
type TypedArrayTag = "f32" | "f64" | "i8" | "i16" | "i32" | "u8" | "u16" | "u32";

const col = new TypedArrayFor["f32"]();   // GrowableFloat32Array
col.push(1.5);
col.view() instanceof Float32Array;       // true
```

`buf` and `view()` share the underlying buffer and are invalidated the next
time a `push()` (or `ensure_capacity` / `bulk_append`) triggers a grow — do
not cache either across appends that might resize.

```ts
// from typed_arrays.test.ts
const a = new GrowableFloat32Array(4);
for (let i = 0; i < 20; i++) a.push(i);
a.length; // 20
a.get(19); // 19

const removed = a.swap_remove(0);   // moves last element into slot 0
```

## BinaryHeap\<T\> (new in v0.2.0)

Array-backed binary heap with a user-supplied comparator. Priority is defined
by the comparator: when `compare(a, b) < 0`, `a` has higher priority and
floats toward the root. `(a, b) => a - b` gives a min-heap; `(a, b) => b - a`
gives a max-heap.

```ts
type CompareFn<T> = (a: T, b: T) => number;

class BinaryHeap<T> {
  constructor(compare: CompareFn<T>)

  readonly size: number
  peek(): T | undefined         // O(1)
  push(value: T): void          // O(log n)
  pop(): T | undefined          // O(log n) — returns highest-priority element
  clear(): void                 // O(1)
}
```

`peek` and `pop` return `undefined` on an empty heap. Layout uses implicit
indexing: root at `0`, children of node `i` at `2i + 1` and `2i + 2`, parent
at `(i - 1) >> 1`.

```ts
// from binary_heap.test.ts
const h = new BinaryHeap<number>((a, b) => a - b);  // min-heap
h.push(5); h.push(3); h.push(8); h.push(1); h.push(4);
h.pop(); // 1
h.pop(); // 3
h.pop(); // 4

// Custom object priority
interface Task { name: string; priority: number; }
const q = new BinaryHeap<Task>((a, b) => a.priority - b.priority);
q.push({ name: "low", priority: 10 });
q.push({ name: "high", priority: 1 });
q.pop()!.name; // "high"
```

## topological_sort (new in v0.2.0)

Kahn's algorithm with a `BinaryHeap` as the ready queue. The tiebreaker
comparator orders nodes that are simultaneously unblocked, so output is
deterministic and priority-driven — not insertion-order dependent.

```ts
function topological_sort<T>(
  nodes: readonly T[],
  edges: Map<T, T[]>,                 // edges.get(a) = items that must come after `a`
  tiebreaker: (a: T, b: T) => number, // min-heap semantics: lower = earlier
  node_name?: (node: T) => string,    // optional label for cycle errors
): T[];
```

Cycles are reported by throwing a built-in `TypeError` (the JavaScript global,
not the library's `TypeError`) listing the names of the nodes still pending:

```
Cycle detected in topological sort. Nodes still pending: A, B
```

```ts
// from topological_sort.test.ts
const edges = new Map<string, string[]>();
edges.set("A", ["B", "C"]);
edges.set("B", ["D"]);
edges.set("C", ["D"]);
const order = new Map([["A", 0], ["B", 1], ["C", 2], ["D", 3]]);

const result = topological_sort(
  ["A", "B", "C", "D"],
  edges,
  (a, b) => order.get(a)! - order.get(b)!,
);
// result[0] === "A", result[3] === "D"
// Tiebreaker picks "B" at index 1 and "C" at index 2.

// Cycles throw:
const cyclic = new Map([["A", ["B"]], ["B", ["A"]]]);
topological_sort(["A", "B"], cyclic, () => 0); // throws TypeError
```

Edges targeting nodes not present in the `nodes` list are ignored.

## Brand\<T, BrandName\>

Zero-cost nominal typing. `Brand<T, Name>` intersects `T` with a phantom
`readonly` symbol property tagged with `Name`. The symbol never exists at
runtime — it only prevents accidental assignment between structurally
identical types.

```ts
type Brand<T, BrandName extends string> = T & { readonly [brand]: BrandName };
```

```ts
// from brand.test.ts
type EntityID = Brand<number, "entity_id">;
type ComponentID = Brand<number, "component_id">;

const id = 42 as EntityID;
typeof id;      // "number"
id + 1;         // 43 — works like a plain number
// Assigning ComponentID → EntityID is a compile-time error
```

Use `validate_and_cast` (below) to produce a branded value with a runtime
check, or `unsafe_cast` when the caller guarantees validity.

## Casting helpers

```ts
is_non_negative_integer(v: number): boolean         // Number.isInteger(v) && v >= 0
is_non_null(v: unknown): boolean                    // v !== null  (note: undefined → true)

unsafe_cast<T>(value: unknown): T                   // no runtime check
validate_and_cast<T, R extends T = T>(
  value: T,
  validator: (v: T) => boolean,
  err_message: string,
): R                                                // throws TypeError on failure in dev
```

`validate_and_cast` is the primary way to mint a branded value:

```ts
type EntityID = Brand<number, "entity_id">;

const make_entity_id = (n: number): EntityID =>
  validate_and_cast(n, is_non_negative_integer, "non-negative integer");

const id = make_entity_id(7);  // OK
make_entity_id(-1);            // throws TypeError in dev
```

`unsafe_cast` is a pure type cast — the value is returned unchanged, including
`null` and `undefined`.

## Assertions

Runtime validation helpers. **All checks are guarded by the `__DEV__` compile
constant and tree-shaken out of production builds**, so in production they're
no-ops.

```ts
// Throws if value is null or undefined
assert_non_null<T>(value: T): asserts value is NonNullable<T>

// Throws unless condition(value) returns true; narrows value to Result
assert<T, Result extends T = T>(
  value: T,
  condition: (v: T) => v is Result,
  err_message: string,
): asserts value is Result
```

Both throw the library's `TypeError` with a category tag so callers can
distinguish failure modes:

| Helper | Category |
| --- | --- |
| `assert_non_null` | `TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE` |
| `assert` | `TYPE_ERROR.ASSERTION_FAIL_CONDITION` |
| `validate_and_cast` | `TYPE_ERROR.VALIDATION_FAIL_CONDITION` |

```ts
// from assertions.test.ts
const is_positive = (v: number): v is number => v > 0;
assert(5, is_positive, "must be positive");   // ok
assert(-1, is_positive, "must be positive");  // throws TypeError

try { assert_non_null(null); }
catch (e) {
  (e as TypeError).category === TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE; // true
}
```

Note: `assert_non_null` rejects both `null` and `undefined` (it uses `== null`),
while `is_non_null` only rejects `null` (it uses `!== null`). Use
`assert_non_null` when you want `NonNullable<T>`.

## TYPE_ERROR / TypeError

A dedicated error taxonomy, separate from the ECS error hierarchy so type-
primitive assertions can be used without depending on it.

```ts
enum TYPE_ERROR {
  ASSERTION_FAIL_CONDITION    = "ASSERTION_FAIL_CONDITION",
  VALIDATION_FAIL_CONDITION   = "VALIDATION_FAIL_CONDITION",
  ASSERTION_FAIL_NON_NULLABLE = "ASSERTION_FAIL_NON_NULLABLE",
}

class TypeError extends AppError {
  readonly category: TYPE_ERROR;
  constructor(category: TYPE_ERROR, message: string, context?: Record<string, unknown>);
}
```

Catch by class and branch on `.category`:

```ts
try {
  validate_and_cast(-1, (v) => v > 0, "positive");
} catch (e) {
  if (e instanceof TypeError) {
    switch (e.category) {
      case TYPE_ERROR.VALIDATION_FAIL_CONDITION: /* ... */ break;
      case TYPE_ERROR.ASSERTION_FAIL_CONDITION: /* ... */ break;
      case TYPE_ERROR.ASSERTION_FAIL_NON_NULLABLE: /* ... */ break;
    }
  }
}
```

`TypeError` here is the library's class; it shadows the JavaScript global
inside this module. `topological_sort` throws the **built-in** `TypeError`
(via `globalThis.TypeError`) for cycles — don't confuse the two.
