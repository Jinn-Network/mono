// SPDX-License-Identifier: Apache-2.0

import type { EffectiveRequirements, TaskSpecification } from "@jinn-network/task-execution-protocol";
import type { TaskProfileDocument } from "@jinn-network/task-execution-profiles";

/**
 * The parsed Task ⊎ Submission effective requirements ⊎ resolved profile document (design §8.1,
 * frozen interface §14 item 8). This is the launcher's ONLY input alongside workspace paths and
 * attempt identity — the launcher never re-reads raw sealed bytes.
 *
 * Homed in `workspace` (not `supervisor`) because it carries the profiles-typed
 * `TaskProfileDocument`, and the supervisor package must stay profiles-free (backend plan
 * Finding (e)).
 *
 * `effectiveRequirements` is protocol's own `EffectiveRequirements` map — its VALUE is produced
 * by the assembly running protocol's `mergeRequirements(Task ⊎ Submission, keyClasses)` at
 * `submit` (Milestone C, Task C1) and folding the returned `effective` map into this view; this
 * package only defines the type reference, never re-declares the merge (program §7.3).
 *
 * `profile.workspaceKind` is NOT a field on the profile document — workspace kind is derived by
 * `ProvisionerContract.workspaceKind(view)` from `profile` (design §7.2, `contract.ts`).
 */
export interface TaskView {
  readonly task: TaskSpecification;
  readonly effectiveRequirements: EffectiveRequirements;
  readonly profile: TaskProfileDocument;
}
