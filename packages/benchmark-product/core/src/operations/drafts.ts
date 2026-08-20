/**
 * Draft CRUD (spec §4.6 Benchmark draft row): the mutable, pre-lock document
 * a sponsor composes before a later packet compiles it into a sealed Run
 * record at lock time (draft.ts's own header). Every write here runs through
 * `operate` (spec §5.1), so validation, the locked-refuses-mutation rule
 * (§4.1), and the audit append are enforced once, at this boundary, never
 * per surface.
 *
 * `createDraft` and `updateDraft` both need the same instant for a document
 * timestamp (createdAt/updatedAt) and for the audit entry's `at`. Each calls
 * `context.clock()` exactly once, then wraps the context with a constant
 * `clock` before calling `operate` — so `operate`'s own internal
 * `context.clock()` call returns that same cached instant rather than
 * advancing the caller's clock a second time (see operate.ts).
 */

import { existsSync, readdirSync } from "node:fs";
import { refuse, refuseWithIssues } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import {
  DRAFT_SPEC_DEFAULTS,
  DraftIdSchema,
  draftIdFromName,
  parseDraftDocument,
  parseDraftSpec,
  type DraftDocument,
} from "../domain/draft.js";
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { draftPath, draftsDir } from "../workspace/layout.js";
import type { OperationContext } from "./context.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

/** The top-level DraftSpec fields a patch may touch (spec §4.5, mirrors DraftSpecSchema). */
const DRAFT_SPEC_FIELD_NAMES = new Set([
  "name",
  "description",
  "taskSet",
  "arms",
  "replicates",
  "assurance",
  "policy",
  "budget",
  "venue",
  "evaluationRuntime",
  "analysis",
  "additionalAnalyses",
  "anchoring",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves the caller-supplied draftId (validated) or slugs one from the name. */
function resolveDraftId(input: { readonly draftId?: string; readonly name: string }): string {
  if (input.draftId !== undefined) {
    const parsed = DraftIdSchema.safeParse(input.draftId);
    if (!parsed.success) {
      refuseWithIssues(
        "validation",
        parsed.error.issues.map((issue) => ({
          path: issue.path.length > 0 ? issue.path.join(".") : "draftId",
          message: issue.message,
        })),
      );
    }
    return parsed.data;
  }
  return draftIdFromName(input.name);
}

/** Reads and parses a draft document by id. Shared by every read path in this module and by inspect.ts. */
export function readDraftDocument(workspaceDir: string, draftId: string): DraftDocument {
  const path = draftPath(workspaceDir, draftId);
  const bytes = readFileIfExistsSync(path);
  if (bytes === undefined) {
    refuse("not-found", path, `draft ${draftId} does not exist`);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", path, `draft file ${path} is not valid JSON`);
  }
  return parseDraftDocument(json);
}

export interface CreateDraftInput {
  readonly name: string;
  readonly description?: string;
  readonly draftId?: string;
  readonly spec?: unknown;
}

function buildSpecForCreate(input: CreateDraftInput) {
  let specInput: Record<string, unknown> = {};
  if (input.spec !== undefined) {
    if (!isPlainObject(input.spec)) {
      refuse("validation", "spec", "spec must be a plain object");
    }
    specInput = input.spec;
  }
  const merged: Record<string, unknown> = {
    ...DRAFT_SPEC_DEFAULTS,
    ...specInput,
    // The explicit name flag is authoritative even when spec also carries a name.
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  return parseDraftSpec(merged);
}

export function createDraft(
  context: OperationContext,
  input: CreateDraftInput,
): OperationResult<{ draft: DraftDocument }> {
  // Computed defensively, outside operate(), so a refusal still has a usable
  // audit subject even when id resolution itself is what fails.
  let precomputedId: string | undefined;
  try {
    precomputedId = resolveDraftId(input);
  } catch {
    // Swallowed here — the real refusal is re-raised from inside `run` below.
  }
  const subject = precomputedId ?? "draft";

  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "draft.create",
    subject,
    inputs: input,
    run: () => {
      const draftId = precomputedId ?? resolveDraftId(input);
      const path = draftPath(clockedContext.workspaceDir, draftId);
      if (existsSync(path)) {
        refuse("conflict", path, `draft ${draftId} already exists`);
      }

      const spec = buildSpecForCreate(input);
      const document: DraftDocument = { draftId, createdAt: at, updatedAt: at, state: "draft", spec };
      atomicWriteFileSync(path, JSON.stringify(document, null, 2));
      return { draft: document };
    },
  });
}

export interface UpdateDraftInput {
  readonly draftId: string;
  readonly patch: unknown;
}

export function updateDraft(
  context: OperationContext,
  input: UpdateDraftInput,
): OperationResult<{ draft: DraftDocument }> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "draft.update",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const path = draftPath(clockedContext.workspaceDir, input.draftId);
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);

      // The locked-refuses-mutation rule (spec §4.1): once a draft is past
      // draft/quoted, the product refuses any mutation of it outright.
      if (!isDraftMutable(document.state)) {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" and refuses mutation`,
        );
      }

      // Editing a quoted draft invalidates the quote (A2): the transition
      // table already encodes quoted --edit--> draft, so we drive it through
      // rather than special-casing the state name here.
      let nextState: LifecycleState = document.state;
      if (document.state === "quoted") {
        const result = transition("quoted", "edit");
        if (result.ok) nextState = result.state;
      }

      if (!isPlainObject(input.patch)) {
        refuse("validation", "patch", "patch must be a plain object");
      }
      const unknownKeys = Object.keys(input.patch).filter((key) => !DRAFT_SPEC_FIELD_NAMES.has(key));
      if (unknownKeys.length > 0) {
        refuseWithIssues(
          "validation",
          unknownKeys.map((key) => ({ path: key, message: `unknown draft spec field: ${key}` })),
        );
      }

      // Shallow merge — no field-removal semantics in v1: an absent patch key
      // leaves the existing spec value untouched; a present key overwrites it
      // wholesale (a nested object like `policy` is replaced, not deep-merged).
      const spec = parseDraftSpec({ ...document.spec, ...input.patch });
      const updated: DraftDocument = { ...document, state: nextState, updatedAt: at, spec };
      atomicWriteFileSync(path, JSON.stringify(updated, null, 2));
      return { draft: updated };
    },
  });
}

export function getDraft(
  context: OperationContext,
  input: { readonly draftId: string },
): OperationResult<{ draft: DraftDocument }> {
  return operate({
    context,
    action: "draft.get",
    subject: input.draftId,
    inputs: input,
    run: () => ({ draft: readDraftDocument(context.workspaceDir, input.draftId) }),
  });
}

export interface DraftSummary {
  readonly draftId: string;
  readonly name: string;
  readonly state: LifecycleState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function listDrafts(context: OperationContext): OperationResult<{ drafts: readonly DraftSummary[] }> {
  return operate({
    context,
    action: "draft.list",
    subject: "workspace",
    inputs: {},
    run: () => {
      const dir = draftsDir(context.workspaceDir);
      const fileNames = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
      const draftIds = fileNames.map((name) => name.slice(0, -".json".length)).sort();

      const drafts = draftIds.map((draftId): DraftSummary => {
        const document = readDraftDocument(context.workspaceDir, draftId);
        return {
          draftId: document.draftId,
          name: document.spec.name,
          state: document.state,
          createdAt: document.createdAt,
          updatedAt: document.updatedAt,
        };
      });
      return { drafts };
    },
  });
}
