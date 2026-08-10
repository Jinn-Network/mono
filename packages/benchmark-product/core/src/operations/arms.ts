/**
 * Arm definition on drafts (spec §4.5/§4.6): add / update / remove / list the
 * arms a draft compares. Every mutation follows the same draft-mutability and
 * quoted→draft-on-edit rules `updateDraft` established (see drafts.ts's own
 * header) — reproduced here rather than shared, since attaching to a shared
 * helper would mean importing across a module this packet does not own.
 *
 * `armId` and `pinning` are validated explicitly before the draft file is even
 * read, so a malformed id or a non-object pinning refuses "validation" with a
 * clean top-level issue path, never a `spec.arms.N.*` path buried inside the
 * whole-spec re-parse.
 *
 * Every mutation result — and `armList`'s read-only result — carries
 * `warnings: readonly ArmWarning[]`: arms whose pinning is byte-identical
 * (compared via `inputsDigest`, the same stable-JSON digest the audit journal
 * uses for attribution) are grouped into one `duplicate-pinning` warning per
 * group. This is deliberately a WARNING, not a refusal — arm definition must
 * not require any launcher to exist, and two arms sharing a pinning is legal
 * product state. The HARD pairwise-distinctness check belongs to the
 * platform's run planner at lock time (a later packet); this module only
 * surfaces the draft-time signal a sponsor can act on before locking.
 */

import { z } from "zod";
import { inputsDigest } from "../audit/journal.js";
import {
  ArmIdSchema,
  ArmSchema,
  parseDraftSpec,
  type DraftDocument,
} from "../domain/draft.js";
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

type Arm = z.infer<typeof ArmSchema>;

export interface ArmWarning {
  readonly code: "duplicate-pinning";
  readonly armIds: readonly string[];
  readonly detail: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertArmId(armId: string): void {
  if (!ArmIdSchema.safeParse(armId).success) {
    refuse("validation", "armId", "armId must match [A-Za-z0-9_-]{1,64}");
  }
}

function assertPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    refuse("validation", path, `${path} must be a plain object`);
  }
  return value;
}

/** Mirrors updateDraft's own mutability + quoted→draft transition (drafts.ts). */
function ensureMutable(document: DraftDocument, draftId: string): LifecycleState {
  if (!isDraftMutable(document.state)) {
    refuse(
      "illegal-transition",
      `drafts.${draftId}.state`,
      `draft ${draftId} is in state "${document.state}" and refuses mutation`,
    );
  }
  let nextState: LifecycleState = document.state;
  if (document.state === "quoted") {
    const result = transition("quoted", "edit");
    if (result.ok) nextState = result.state;
  }
  return nextState;
}

function computeDuplicatePinningWarnings(arms: readonly Arm[]): ArmWarning[] {
  const groups = new Map<string, string[]>();
  for (const arm of arms) {
    const digest = inputsDigest(arm.pinning);
    const group = groups.get(digest);
    if (group === undefined) {
      groups.set(digest, [arm.armId]);
    } else {
      group.push(arm.armId);
    }
  }
  const warnings: ArmWarning[] = [];
  for (const armIds of groups.values()) {
    if (armIds.length > 1) {
      warnings.push({
        code: "duplicate-pinning",
        armIds,
        detail: `arms ${armIds.join(", ")} share identical pinning`,
      });
    }
  }
  return warnings;
}

function writeDraft(workspaceDir: string, draftId: string, document: DraftDocument): void {
  atomicWriteFileSync(draftPath(workspaceDir, draftId), JSON.stringify(document, null, 2));
}

export interface ArmAddInput {
  readonly draftId: string;
  readonly armId: string;
  readonly pinning: unknown;
  readonly notes?: string;
}

export function armAdd(
  context: OperationContext,
  input: ArmAddInput,
): OperationResult<{ draft: DraftDocument; warnings: readonly ArmWarning[] }> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "arm.add",
    subject: input.draftId,
    inputs: input,
    run: () => {
      assertArmId(input.armId);
      const pinning = assertPlainObject(input.pinning, "pinning");

      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const nextState = ensureMutable(document, input.draftId);

      if (document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("conflict", `drafts.${input.draftId}.arms.${input.armId}`, `arm ${input.armId} already exists`);
      }

      const newArm: Arm = { armId: input.armId, pinning, ...(input.notes !== undefined ? { notes: input.notes } : {}) };
      const spec = parseDraftSpec({ ...document.spec, arms: [...document.spec.arms, newArm] });
      const updated: DraftDocument = { ...document, state: nextState, updatedAt: at, spec };
      writeDraft(clockedContext.workspaceDir, input.draftId, updated);

      return { draft: updated, warnings: computeDuplicatePinningWarnings(updated.spec.arms) };
    },
  });
}

export interface ArmUpdateInput {
  readonly draftId: string;
  readonly armId: string;
  readonly pinning?: unknown;
  readonly notes?: string;
}

export function armUpdate(
  context: OperationContext,
  input: ArmUpdateInput,
): OperationResult<{ draft: DraftDocument; warnings: readonly ArmWarning[] }> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "arm.update",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const pinningOverride = input.pinning === undefined ? undefined : assertPlainObject(input.pinning, "pinning");

      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const nextState = ensureMutable(document, input.draftId);

      const index = document.spec.arms.findIndex((arm) => arm.armId === input.armId);
      if (index === -1) {
        refuse("not-found", `drafts.${input.draftId}.arms.${input.armId}`, `arm ${input.armId} does not exist`);
      }

      const existing = document.spec.arms[index]!;
      const pinning = pinningOverride ?? existing.pinning;
      const notes = input.notes !== undefined ? input.notes : existing.notes;
      const updatedArm: Arm = { armId: existing.armId, pinning, ...(notes !== undefined ? { notes } : {}) };
      const arms = document.spec.arms.map((arm, i) => (i === index ? updatedArm : arm));

      const spec = parseDraftSpec({ ...document.spec, arms });
      const updated: DraftDocument = { ...document, state: nextState, updatedAt: at, spec };
      writeDraft(clockedContext.workspaceDir, input.draftId, updated);

      return { draft: updated, warnings: computeDuplicatePinningWarnings(updated.spec.arms) };
    },
  });
}

export interface ArmRemoveInput {
  readonly draftId: string;
  readonly armId: string;
}

export function armRemove(
  context: OperationContext,
  input: ArmRemoveInput,
): OperationResult<{ draft: DraftDocument; warnings: readonly ArmWarning[] }> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "arm.remove",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const nextState = ensureMutable(document, input.draftId);

      if (!document.spec.arms.some((arm) => arm.armId === input.armId)) {
        refuse("not-found", `drafts.${input.draftId}.arms.${input.armId}`, `arm ${input.armId} does not exist`);
      }

      const arms = document.spec.arms.filter((arm) => arm.armId !== input.armId);
      const spec = parseDraftSpec({ ...document.spec, arms });
      const updated: DraftDocument = { ...document, state: nextState, updatedAt: at, spec };
      writeDraft(clockedContext.workspaceDir, input.draftId, updated);

      return { draft: updated, warnings: computeDuplicatePinningWarnings(updated.spec.arms) };
    },
  });
}

export function armList(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<{ arms: readonly Arm[]; warnings: readonly ArmWarning[] }> {
  return operate({
    context,
    action: "arm.list",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(context.workspaceDir, input.draftId);
      return { arms: document.spec.arms, warnings: computeDuplicatePinningWarnings(document.spec.arms) };
    },
  });
}
