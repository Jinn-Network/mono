// SPDX-License-Identifier: MIT

/**
 * The transfer security gradient, as a classifier over a candidate's tree paths (product §7.4).
 *
 * > Payload classes carry escalating risk — prompts < skills (injection surface) < hooks/tool
 * > configs (arbitrary code execution) < harness forks (their runtime).
 *
 * §7.3 makes admission of the top two classes **code-execution consent**: "the smoke canary and
 * every subsequent cell *run* the payload". So the classifier's job is not to describe a candidate
 * politely; it is to decide what an owner is being asked to consent to.
 *
 * ## FINDING F-C7c-4 — the design names four classes, not which paths they are
 *
 * §7.4 lists the gradient by example ("prompts", "skills", "hooks/tool configs", "harness forks")
 * and never maps it onto `learner-public.v1`'s thirteen allowed roots. The mapping below is this
 * unit's, stated in full so a reviewer can disagree with a specific line rather than with a
 * behavior. Two rules governed it:
 *
 * 1. **Executability decides, not intent.** A root whose contents a harness *runs* — hooks, tools,
 *    configs the runtime consumes, tunables it reads as parameters, tests it executes — is
 *    `hook-or-tool-config`. `tests/` is the line most likely to be argued with: a learner-authored
 *    test is a script, and a script that runs during evaluation is arbitrary code execution
 *    whatever the directory is called.
 * 2. **Ties go to the more hostile class.** A misclassification toward `prompt` is a hostile
 *    payload admitted without consent; toward `hook-or-tool-config` it is one consent prompt an
 *    owner did not strictly need. Only one of those is recoverable.
 *
 * `harness-code` is deliberately **unreachable from inside a `jinn.harness-state.v1` tree**: the
 * profile's top-level classification is exhaustive (substrate §4.2) and none of its roots is a
 * harness fork. It is reached instead by the *loadout kind* — a candidate pinning a loadout this
 * package does not recognize is proposing a runtime nobody has classified, which is the definition
 * of the class.
 */

import { HARNESS_STATE_LOADOUT_KIND } from "@jinn-network/policy-identity";
import type { TreeEntry } from "@jinn-network/policy-identity";
import { HOSTILE_PAYLOAD_CLASSES, PAYLOAD_CLASSES } from "../tokens.js";

export type PayloadClass = (typeof PAYLOAD_CLASSES)[number];

const HOSTILE = new Set<string>(HOSTILE_PAYLOAD_CLASSES);

/** Rank on the §7.4 gradient. Higher is more dangerous; the order is `PAYLOAD_CLASSES`'. */
export function payloadClassRank(payloadClass: PayloadClass): number {
  return PAYLOAD_CLASSES.indexOf(payloadClass);
}

export function isHostilePayloadClass(payloadClass: PayloadClass): boolean {
  return HOSTILE.has(payloadClass);
}

/**
 * The root-to-class map. Total over `learner-public.v1`'s allowed roots (substrate §4.2's
 * `LEARNER_PUBLIC_V1_ALLOWED_DIRS` plus `policy.json`), so an unmapped root means the profile grew
 * one and this map did not — caught by a test rather than defaulted.
 */
const ROOT_CLASS = new Map<string, PayloadClass>([
  // Prose the harness reads. Injection surface exists here too, but reading is not running.
  ["policy.json", "prompt"],
  [".archive", "prompt"],
  ["notes", "prompt"],
  ["plans", "prompt"],
  ["runs", "prompt"],
  // Instructions a harness follows as an agent — §7.4's named injection surface.
  ["agents", "skill"],
  ["patterns", "skill"],
  ["skills", "skill"],
  ["strategies", "skill"],
  // Contents a harness executes or consumes as runtime configuration.
  ["configs", "hook-or-tool-config"],
  ["hooks", "hook-or-tool-config"],
  ["tests", "hook-or-tool-config"],
  ["tools", "hook-or-tool-config"],
  ["tunables", "hook-or-tool-config"],
]);

/** Exposed so a drift test can assert the map covers exactly the profile's classification. */
export function classifiedRoots(): readonly string[] {
  return [...ROOT_CLASS.keys()].sort();
}

function topLevelSegment(path: string): string {
  const separator = path.indexOf("/");
  return separator === -1 ? path : path.slice(0, separator);
}

export interface PayloadClassification {
  /** Every class present, sorted by ascending gradient rank. */
  readonly classes: readonly PayloadClass[];
  /** The highest-ranked class present — what an owner is actually consenting to. */
  readonly highest: PayloadClass;
  /** The classes in `classes` that require admission-time consent from a cross-operator proposer. */
  readonly hostile: readonly PayloadClass[];
  /** Which paths put each hostile class there, sorted. Named so a consent prompt can be specific. */
  readonly hostilePaths: readonly string[];
}

/**
 * Classifies a materialized candidate package.
 *
 * `loadoutKind` is separate from the entries because the most dangerous class is a property of the
 * *pin*, not of any path: a candidate proposing an unrecognized loadout kind is proposing a runtime,
 * and no walk of its files could tell you that.
 *
 * An empty tree classifies as `prompt`: it carries nothing that runs, and calling "nothing" hostile
 * would train owners to click through the consent prompt.
 */
export function classifyPayload(
  entries: readonly TreeEntry[],
  loadoutKind: string,
): PayloadClassification {
  const present = new Set<PayloadClass>();
  const hostilePaths: string[] = [];

  if (loadoutKind !== HARNESS_STATE_LOADOUT_KIND) {
    present.add("harness-code");
    hostilePaths.push(`loadout.kind=${loadoutKind}`);
  }

  for (const entry of entries) {
    const root = topLevelSegment(entry.path);
    // An unclassified root cannot reach here through admission — `hashTreeLearnerPublicV1` refuses
    // it first — but this function is callable on its own, and guessing `prompt` for an unknown
    // root is exactly the tie this module resolves toward the hostile class.
    const payloadClass = ROOT_CLASS.get(root) ?? "harness-code";
    present.add(payloadClass);
    if (HOSTILE.has(payloadClass)) hostilePaths.push(entry.path);
  }

  if (present.size === 0) present.add("prompt");
  const classes = [...present].sort((left, right) => payloadClassRank(left) - payloadClassRank(right));
  return {
    classes,
    highest: classes[classes.length - 1]!,
    hostile: classes.filter((entry) => HOSTILE.has(entry)),
    hostilePaths: [...new Set(hostilePaths)].sort(),
  };
}
