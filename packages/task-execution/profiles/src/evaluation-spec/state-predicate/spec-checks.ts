import { ProfilesError } from "../../errors.js";
import { STATE_PREDICATE_FAMILY, StatePredicateBlockSchema } from "../family-blocks.js";

/** Structural check for the `state-predicate-block` fixture family: parses a
 * `{family, block}` case and throws `ProfilesError("invalid-document")` on any violation, so
 * `runStructuralCheck` can project it to `{ok:false, code}`. */
export function checkStatePredicateBlock(input: unknown): unknown {
  const { family, block } = input as { family: string; block: unknown };
  if (family !== STATE_PREDICATE_FAMILY) {
    throw new ProfilesError("invalid-document", `expected family "${STATE_PREDICATE_FAMILY}"`);
  }
  const parsed = StatePredicateBlockSchema.safeParse(block);
  if (!parsed.success) {
    throw new ProfilesError("invalid-document", "state-predicate block failed schema validation");
  }
  return parsed.data;
}
