# OECS Design Notes

Optimization rationale extracted from source comments. Code sites are marked with
`// optimization*N` (single-line) or `// optimization*N start/end` (multi-line blocks).

---

## [opt:1] Packed generational entity ID

**Files:** `entity/entity.ts`, `entity/entity_registry.ts`

Every entity is represented as a single 32-bit integer with two packed fields:

```
Bits:  [31 ........... 20][19 ........... 0]
        generation (12)     index (20)
```

- **index** — which slot in the entity array (seat number). 20 bits → up to ~1 million concurrent entities.
- **generation** — how many times that slot has been reused. 12 bits → wraps after 4 096 reuses per slot,
  sufficient to catch virtually all stale references in practice.

Packing both into one number yields a copy-friendly, trivially-comparable (`===`) identifier that guards
against the "dangling pointer" problem: holding an old ID after the slot was recycled returns `false` from
`is_alive()` because the baked-in generation no longer matches.

The `>>> 0` coercion at pack time forces the result to an unsigned 32-bit integer so that large generation
values (high bit set) are not misinterpreted as negative by JS bitwise operators.

---

## [opt:2] Sparse-set membership in Archetype

**Files:** `archetype/archetype.ts`

Entity membership uses a classic sparse-set backed by typed arrays:

- **`entity_ids` (Uint32Array, dense)** — holds packed EntityIDs at positions 0..N-1.
  `Uint32Array` is required because EntityIDs use unsigned coercion (`>>> 0`) and can exceed the
  `Int32` range; a signed array would silently corrupt high-generation IDs.
- **`index_to_row` (Int32Array, sparse)** — maps `entity_index → row`. The sentinel `EMPTY_ROW = -1`
  marks unused slots; valid rows are always non-negative, so `-1` is unambiguous even in a signed array.

Swap-and-pop on remove applies to ALL component columns simultaneously, keeping data dense.

---

## [opt:3] Archetype graph edge cache

**Files:** `archetype/archetype.ts`, `archetype/archetype_registry.ts`

Each `Archetype` stores a `Map<ComponentID, ArchetypeEdge>` where an edge records:

```ts
{ add: ArchetypeID | null, remove: ArchetypeID | null }
```

Edges are lazily populated by `ArchetypeRegistry` the first time a transition is resolved. On a cache
miss, the registry builds the target mask, gets-or-creates the target archetype, and then writes **both
directions** of the edge atomically (`cache_edge`). Subsequent add/remove transitions for the same
component are O(1) Map lookups with no mask arithmetic.

---

## [opt:4] `get_matching`: smallest-set-first intersection + inlined bit-scan

**Files:** `archetype/archetype_registry.ts`

`get_matching` finds all archetypes whose mask is a superset of a query mask. Rather than iterating all
archetypes, it uses a component index (`ComponentID → Set<ArchetypeID>`) and starts from the component
with the fewest archetypes (smallest set). This minimises the number of `contains` calls.

The bit-scan over the query mask is inlined rather than delegated to `BitSet.for_each`. Avoiding the
`for_each` closure eliminates a function allocation per call on the hot query path.

---

## [opt:5] `Object.freeze(mask)` after archetype creation

**Files:** `archetype/archetype_registry.ts`

After a new archetype's `BitSet` mask is built, it is frozen with `Object.freeze`. This signals to the
V8 JIT that the object's shape will never change, allowing V8 to treat it as a monomorphic hidden class
throughout its lifetime. Mutable objects with the same initial shape can de-optimise to megamorphic IC
sites if V8 observes property additions/deletions; freezing prevents that.

---

## [opt:6] Query scratch mask + `arguments` iteration

**Files:** `query/query.ts`

`SystemContext.query()` maintains a single reusable `scratch_mask: BitSet` on the context object. On
each call the mask is cleared (words filled to zero) and bits are set for each argument. Using
`arguments` instead of a rest parameter (`...defs`) avoids allocating a temporary array for the
arguments on every call — rest parameters always materialise a new `Array` even when the callee is
inlined.

---

## [opt:7] Query method overloads

**Files:** `query/query.ts`

The `query()` method is declared with explicit single-argument overloads in addition to the variadic
signature. This gives TypeScript callers precise return types without a rest-parameter array allocation
at the call site for the common case of querying a single component.

---

## [opt:8] Kahn's algorithm + binary min-heap for topological sort

**Files:** `schedule/schedule.ts`

Systems within a phase are sorted by a topological sort that respects `before`/`after` ordering
constraints. Kahn's algorithm processes nodes by in-degree (edges satisfied = eligible to emit), using a
binary min-heap keyed by insertion order as a tiebreaker for deterministic output.

Complexity: **O((V+E) log V)** where V = system count and E = ordering edges. The previous
implementation re-sorted an array on every insert, giving O(V² log V).

---

## [opt:9] Amortised O(1) array growth via capacity doubling

**Files:** `entity/entity_registry.ts`, `archetype/archetype.ts`, `utils/arrays.ts`

Several fixed-size typed arrays (`Uint16Array` for entity generations, `Uint32Array`/typed columns in
archetypes, `Int32Array` for `index_to_row`) start at a small initial capacity and double when they
outgrow it. Doubling amortises the cost of copying to O(1) per element appended. This avoids per-element
boxing or GC pressure on hot allocation paths while keeping memory compact for small worlds.
