---

piecs vs oecs — concrete comparison

What piecs actually is

piecs is a membership-only ECS. It tracks which entities belong to which archetypes, but stores no
component data. Users own their own TypedArrays and index them by entity ID directly. The library's
entire job is: tell the system which entity IDs are in scope.

// piecs system — user owns pos/vel arrays globally
const pos = { x: new Float32Array(MAX), y: new Float32Array(MAX) };
const vel = { vx: new Float32Array(MAX), vy: new Float32Array(MAX) };

createEntitySystem((entities, world) => {
for (let i = 0; i < entities.length; i++) {
const e = entities[i]; // entity ID = index into global arrays
pos.x[e] += vel.vx[e]; // direct indexed access, no indirection
}
}, query(b => b.every(POS, VEL)));

oecs manages component data inside archetype-local dense columns. These are fundamentally different
philosophies, so some comparisons are architectural rather than speed gaps.

---

Where piecs wins

1. Archetype edge lookup: adjacent[] array vs our Map

piecs uses a sparse array indexed by componentId:
// piecs Archetype.ts
const adjacent: InternalArchetype[] = [];
// lookup: adjacent[componentId] — O(1) integer index

oecs uses Map<ComponentID, ArchetypeEdge>. On every add_component / remove_component, we call
edges.get(component_id). Array index beats Map lookup for integer keys. This is a concrete, easy-to-fix
gap.

2. System query resolution: zero overhead vs hash-per-call

piecs systems carry their Query object as a property — resolved once at registration and updated
incrementally when new archetypes are created. During update(), the inner loop is literally:
const archetypes = system.query.archetypes; // direct array read, no computation

In oecs, ctx.query(Pos, Vel) called inside a system runs: build scratch mask → hash() FNV-1a over words
→ cache.get(key) → bucket scan with equals(). The scratch-mask trick avoids allocation, but the
hash+lookup runs every frame. If a system stores the result of query() outside the system function body
(e.g. in a closure), this is already avoided. But the API makes it easy to call it inside the function
each tick.

3. Global user arrays vs archetype-local columns: different cache trade-offs

In piecs, all entities ever created share one global component array. Entities in the same archetype
often have scattered IDs (e.g. 5, 47, 103, 200...) — their component data is non-contiguous in memory.

In oecs, archetype columns are dense rows 0..N-1. Iterating an archetype always streams sequentially
through memory. oecs actually wins here — but piecs's zero-overhead indexing offsets that.

4. Object.freeze on archetypes

piecs freezes every archetype, query, and system object. V8 treats frozen objects as having a stable
hidden class, which helps JIT optimize property access. oecs removed the freeze from masks and doesn't
freeze its Query/Archetype objects.

5. No get_entity_index in the entity iteration loop

In piecs the entity ID is the array index — no unpacking needed. In oecs, the generational ID packing
means any code that needs the index must call id & 0xFFFFF. In each() this isn't actually in the hot
path (systems iterate by row), but in get_field / set_field on individual entities it adds an op.

---

Where oecs wins

1. Dense archetype columns = guaranteed cache locality

oecs columns are always rows 0..N-1, packed contiguously regardless of entity ID assignment. In piecs,
pos.x[entities[0]], pos.x[entities[1]]... can be anywhere in the global array. For large, stable
archetypes oecs has the better memory access pattern.

2. Generational IDs — no ABA problem

piecs reuses entity IDs without a generation counter. A system holding a stale ID after the entity is
deleted and a new one created at the same slot has no way to detect this. oecs's 12-bit generation
counter makes stale IDs detectable.

3. Full scheduling system

piecs runs systems in registration order, no before/after constraints, no phase concept. oecs has 6
phases with topological ordering.

4. Archetype deduplication at scale

piecs finds an existing archetype by traversing the archetype graph (traverseArchetypeGraph) — BFS/DFS
that visits every archetype. oecs uses a hash-bucket map: O(1) expected lookup regardless of how many
archetypes exist. For worlds with hundreds of archetypes, oecs scales better here.

5. Push-based query update

When a new archetype is created in piecs, it checks every registered system's query
(\_tryAddArchetypeToQueries). oecs does the same (registered_queries), and both are O(queries) —
equivalent. But oecs's registered_queries live on the registry and don't require traversing the graph.

---

Concrete actionable gaps

Gap: Replace Map<ComponentID, ArchetypeEdge> with InternalArchetype[] sparse array
Effort: Low
Impact: Medium — every add/remove component transition
────────────────────────────────────────
Gap: Don't call ctx.query() inside system functions each tick — document/enforce call-once pattern
Effort: None (doc/convention)
Impact: High if currently violated
────────────────────────────────────────
Gap: Object.freeze on Query and Archetype objects
Effort: Low
Impact: Unknown — worth benchmarking
────────────────────────────────────────
Gap: BitSet: consider Int32Array for \_words instead of number[]
Effort: Low
Impact: Minor; V8 already optimizes all-integer number[] similarly

The adjacent[] array is the clearest mechanical gap: an integer-keyed sparse array beats a Map for the
archetype graph edge cache, which is on the critical path of every structural change.
