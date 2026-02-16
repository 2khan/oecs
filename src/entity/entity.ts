/***
 *
 * Entity - Packed generational ID
 *
 * Every entity in the game world needs a unique name tag so we can refer to it.
 * Rather than using a plain number (which can go stale when an entity is deleted
 * and its slot is handed to a newcomer), we pack two pieces of information into
 * a single 32-bit integer:
 *
 *   Bits:  [31 ........... 20][19 ........... 0]
 *           generation (12)     index (20)
 *
 *   index      - Which slot in the entity array this entity occupies.
 *                Think of it as a seat number in a theatre.
 *
 *   generation - How many times that seat has been reused. Each time an entity
 *                is destroyed and the seat is given to someone new, the
 *                generation ticks up by one. This lets us tell apart the
 *                current occupant from any previous one, even though they
 *                share the same seat number.
 *
 * By combining both values into one number we get a lightweight, copy-friendly
 * identifier that is trivially comparable (just ===) while still guarding
 * against the "dangling pointer" problem: holding onto an old ID and
 * accidentally addressing whatever now sits in that slot.
 *
 * The bit widths are a trade-off:
 *   - 20 index bits  => ~1 million concurrent entities (more than enough)
 *   - 12 gen bits    => wraps after 4 096 reuses per slot (sufficient to
 *                       catch virtually all stale references in practice)
 *
 ***/

import { Brand, unsafe_cast } from "type_primitives";
import { ECS_ERROR, ECSError } from "../utils/error";

export type EntityID = Brand<number, "entity_id">;

//=========================================================
// Constants
//
// These define the bit layout. Everything else in the file
// derives from them, so changing INDEX_BITS is the only
// knob you'd ever need to turn to resize the split.
//=========================================================
export const INDEX_BITS = 20;
export const INDEX_MASK = (1 << INDEX_BITS) - 1; // 0xF_FFFF - a bitmask of 20 ones
export const MAX_INDEX = INDEX_MASK; // 1_048_575
export const MAX_GENERATION = (1 << (32 - INDEX_BITS)) - 1; // 0xFFF (4095)

//=========================================================
// Pack
//
// Shift the generation left to sit above the index bits,
// then OR the index into the lower region.
//
//   generation: 0000_0000_0111  (7)
//   index:      0000_0000_0000_0010_1010  (42)
//   packed:     0000_0000_0111_0000_0000_0000_0010_1010
//
// Returns unsigned 32-bit integer (" >>> 0")
//=========================================================

export const create_entity_id = (
  index: number,
  generation: number,
): EntityID => {
  if (__DEV__) {
    if (index < 0 || index > MAX_INDEX) {
      throw new ECSError(ECS_ERROR.EID_MAX_INDEX_OVERFLOW);
    }

    if (generation < 0 || generation > MAX_GENERATION) {
      throw new ECSError(ECS_ERROR.EID_MAX_GEN_OVERFLOW);
    }
  }
  return unsafe_cast<EntityID>(((generation << INDEX_BITS) | index) >>> 0);
};

//=========================================================
// Unpack
//
// The reverse of packing - mask or shift to isolate each
// field from the combined integer.
//=========================================================

/** Extract the slot index (low 20 bits). */
export const get_entity_index = (id: EntityID): number => id & INDEX_MASK;

/**
 * Extract the generation counter (high 12 bits).
 *
 * We throw when MAX_GENERATION overflows in dev, but in prod
 * we want to make sure generation never exceeds 12 bits.
 * (" & MAX_GENERATION")
 */
export const get_entity_generation = (id: EntityID): number =>
  (id >>> INDEX_BITS) & MAX_GENERATION;
