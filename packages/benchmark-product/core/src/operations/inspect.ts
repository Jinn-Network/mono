/**
 * Resolves and displays a draft: pinning per arm plus the assurance preset's
 * mapping onto the underlying primitives (spec §6: every surface shows the
 * primitives, never the label alone).
 *
 * Reads `readDraftDocument` directly rather than calling `getDraft` — going
 * through `getDraft` would run its own `operate` boundary and append its own
 * audit entry, giving this operation two entries instead of the one every
 * operation owes the journal (spec §4.4).
 */

import { resolveAssurance, type DraftSpec, type ResolvedAssurance } from "../domain/draft.js";
import type { LifecycleState } from "../domain/lifecycle.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface ArmInspection {
  readonly armId: string;
  readonly pinning: Readonly<Record<string, unknown>>;
  readonly notes?: string;
}

export interface DraftInspection {
  readonly draftId: string;
  readonly state: LifecycleState;
  readonly name: string;
  readonly description?: string;
  readonly venue: "self-run";
  readonly replicates: number;
  readonly taskSet: DraftSpec["taskSet"];
  readonly policy: DraftSpec["policy"];
  readonly budget?: DraftSpec["budget"];
  readonly arms: readonly ArmInspection[];
  readonly assurance: { readonly preset: string; readonly overrides?: unknown; readonly resolved: ResolvedAssurance };
}

export function inspectDraft(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<{ inspection: DraftInspection }> {
  return operate({
    context,
    action: "draft.inspect",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      const spec = document.spec;

      const arms: ArmInspection[] = spec.arms.map((arm) => ({
        armId: arm.armId,
        pinning: arm.pinning,
        notes: arm.notes,
      }));

      const inspection: DraftInspection = {
        draftId: document.draftId,
        state: document.state,
        name: spec.name,
        description: spec.description,
        venue: spec.venue,
        replicates: spec.replicates,
        taskSet: spec.taskSet,
        policy: spec.policy,
        budget: spec.budget,
        arms,
        assurance: {
          preset: spec.assurance.preset,
          overrides: spec.assurance.overrides,
          resolved: resolveAssurance(spec.assurance),
        },
      };
      return { inspection };
    },
  });
}
