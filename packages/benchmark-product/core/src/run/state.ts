/**
 * RunState: the product's own record of one draft's official run (BP-12, M1 composition
 * dossier §1). Distinct from the platform's sealed Run record — RunState is product state
 * (like the audit journal, spec §4.4/§4.5), tracking what this workspace has done toward
 * compiling, sealing, and closing a Run, addressed by the draft it belongs to.
 *
 * `specSha256` is the sha256 hex digest of the draft spec's canonical JSON AT QUOTE TIME —
 * computed with the same sorted-key canonicalization the audit journal's `inputsDigest` uses
 * (reused here, not reimplemented) — so `runLock` can refuse a stale quote (A2: any edit of a
 * quoted draft invalidates the quote) by comparing digests rather than re-diffing documents.
 *
 * `owner` is a deterministic `urn:uuid:` IRI derived from the workspace's own `createdAt` plus
 * the draftId — the same construction `benchmarking-run`'s `launch.ts` uses internally for
 * deterministic Submission URIs (`deterministicSubmissionUri`, not exported publicly, so
 * mirrored here rather than imported). Deterministic so a RunState rebuilt from the same
 * workspace and draftId always names the same owner, and so the value satisfies both the
 * platform Run record's `owner: AgentIriSchema` (any absolute IRI) and the Submission record's
 * `requester: string` — `launchAndWatch` uses `run.owner` as the Submission `requester`
 * (verified in `@jinn-network/benchmarking-run`'s `launch.ts`).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { inputsDigest } from "../audit/journal.js";
import type { DraftSpec } from "../domain/draft.js";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { runStatePath } from "../workspace/layout.js";

const Rfc3339Schema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  "must be an RFC 3339 timestamp",
);

const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase sha256 hex digest");

/** Product policy, rather than a discovery identity. The stable key reference can be resolved
 * by a product host without making a rotating public key part of every RunState. */
export const PublicationSourceSchema = z.object({
  agentKeyRef: z.string().min(1),
  name: z.string().min(1),
  publicBaseUrl: z.string().url().optional(),
});

export const PublicationStageSchema = z.object({
  state: z.enum(["not-started", "in-progress", "complete"]),
  /** A durable source append position. Its presence freezes source identity, never its URL. */
  receipt: z.object({
    sourceSequence: z.string().min(1),
    entrySha256: Sha256HexSchema,
  }).optional(),
  /** Exact record/artifact bytes made durable by this stage, keyed by their product role. */
  digests: z.record(z.string(), Sha256HexSchema).optional(),
});

export const PublicationStateSchema = z.object({
  source: PublicationSourceSchema,
  registration: PublicationStageSchema,
  accounting: PublicationStageSchema,
  report: PublicationStageSchema,
});

export type PublicationSource = z.infer<typeof PublicationSourceSchema>;
export type PublicationStage = z.infer<typeof PublicationStageSchema>;
export type PublicationState = z.infer<typeof PublicationStateSchema>;

export const DEFAULT_PUBLICATION_SOURCE_NAME = "colophon-benchmarks";
export const DEFAULT_PUBLICATION_AGENT_KEY_REF = "workspace-owner";

/** New managed runs always receive this state at quote time. No stage is implied complete. */
export function createPublicationState(source: Partial<PublicationSource> = {}): PublicationState {
  return {
    source: {
      agentKeyRef: source.agentKeyRef ?? DEFAULT_PUBLICATION_AGENT_KEY_REF,
      name: source.name ?? DEFAULT_PUBLICATION_SOURCE_NAME,
      ...(source.publicBaseUrl === undefined ? {} : { publicBaseUrl: source.publicBaseUrl }),
    },
    registration: { state: "not-started" },
    accounting: { state: "not-started" },
    report: { state: "not-started" },
  };
}

/** Mirrors `@jinn-network/benchmarking-run`'s `QuoteReport` (quote.ts) — not re-exported by that package as a schema. */
const QuoteReportSchema = z.object({
  ok: z.boolean(),
  expectedCellCount: z.number().int().nonnegative(),
  estimatedCost: z.object({ value: z.string(), unit: z.string() }).optional(),
  errors: z.array(z.object({
    code: z.enum(["hard-cap-breach", "unsupported-requirement"]),
    detail: z.string(),
  })),
});

export const RunStateSchema = z.object({
  draftId: z.string().min(1),
  /** sha256 hex of the draft spec's canonical JSON as of the most recent quote (A2). */
  specSha256: Sha256HexSchema,
  /** Deterministic `urn:uuid:` run owner (see module header). */
  owner: z.string().min(1),
  quote: QuoteReportSchema.optional(),
  quotedAt: Rfc3339Schema.optional(),
  /** sha256 hex of the sealed Run record's exact bytes, set at `lock`. */
  runSha256: Sha256HexSchema.optional(),
  /** Absolute RFC 3339 close instant compiled into the Run record. */
  closeAt: Rfc3339Schema.optional(),
  lockedAt: Rfc3339Schema.optional(),
  launchedAt: Rfc3339Schema.optional(),
  closedAt: Rfc3339Schema.optional(),
  /** sha256 hex of the sealed Matrix record's exact bytes, set at `run.collect`. */
  matrixSha256: Sha256HexSchema.optional(),
  /** sha256 hex of the sealed Report record's exact PAYLOAD bytes, set at `report` (BP-13). */
  reportSha256: Sha256HexSchema.optional(),
  /** sha256 hex of the sealed Report's DSSE ENVELOPE bytes, set at `report` (BP-13). */
  reportEnvelopeSha256: Sha256HexSchema.optional(),
  /** Profile names. The legacy aliases above remain readable indefinitely. */
  reportPayloadSha256: Sha256HexSchema.optional(),
  reportRecordSha256: Sha256HexSchema.optional(),
  reportedAt: Rfc3339Schema.optional(),
  /** Absent only on historical workspaces created before prospective publication capture. */
  publication: PublicationStateSchema.optional(),
  /** SHA-256 of the exact canonical public bundle manifest bytes (BP-40). */
  bundleIdentity: Sha256HexSchema.optional(),
  /** Workspace-relative digest-addressed immutable target, never an absolute path. */
  bundleRelativePath: z.string().regex(/^artifacts\/[a-z0-9][a-z0-9-]{0,63}\/public-bundles\/[a-f0-9]{64}$/).optional(),
  bundleChecks: z.array(z.enum([
    "manifest",
    "evidence-closure",
    "trust",
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
  ])).optional(),
  publishedAt: Rfc3339Schema.optional(),
}).superRefine((state, context) => {
  if (state.reportSha256 !== undefined && state.reportPayloadSha256 !== undefined
    && state.reportSha256 !== state.reportPayloadSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reportPayloadSha256"], message: "conflicts with legacy reportSha256" });
  }
  if (state.reportEnvelopeSha256 !== undefined && state.reportRecordSha256 !== undefined
    && state.reportEnvelopeSha256 !== state.reportRecordSha256) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["reportRecordSha256"], message: "conflicts with legacy reportEnvelopeSha256" });
  }
}).transform((state) => ({
  ...state,
  ...(state.reportPayloadSha256 === undefined && state.reportSha256 !== undefined
    ? { reportPayloadSha256: state.reportSha256 }
    : {}),
  ...(state.reportRecordSha256 === undefined && state.reportEnvelopeSha256 !== undefined
    ? { reportRecordSha256: state.reportEnvelopeSha256 }
    : {}),
}));

export type RunState = z.infer<typeof RunStateSchema>;

function issuesFromZodError(error: z.ZodError): ProductIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "(root)",
    message: issue.message,
  }));
}

/** Reads and validates the RunState for `draftId`, or `undefined` when none exists yet. */
export function readRunState(workspaceDir: string, draftId: string): RunState | undefined {
  const bytes = readFileIfExistsSync(runStatePath(workspaceDir, draftId));
  if (bytes === undefined) return undefined;

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("validation", runStatePath(workspaceDir, draftId), "run state file is not valid JSON");
  }
  const result = RunStateSchema.safeParse(json);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  return result.data;
}

/** Like `readRunState`, but refuses `"not-found"` instead of returning `undefined`. */
export function requireRunState(workspaceDir: string, draftId: string): RunState {
  const state = readRunState(workspaceDir, draftId);
  if (state === undefined) {
    refuse(
      "not-found",
      `runs.${draftId}`,
      `no run state for draft ${draftId} — quote the draft first`,
    );
  }
  return state;
}

/** Validates and atomically writes the RunState for `draftId`. */
export function writeRunState(workspaceDir: string, draftId: string, state: RunState): void {
  const result = RunStateSchema.safeParse(state);
  if (!result.success) {
    refuseWithIssues("validation", issuesFromZodError(result.error));
  }
  // Source name/key identify an announcement chain. Once any append receipt is durable, changing
  // either — or weakening any already-durable stage fact — would falsely move old positions to a
  // new source/history. A public URL is a locator only and deliberately remains mutable.
  const currentBytes = readFileIfExistsSync(runStatePath(workspaceDir, draftId));
  if (currentBytes !== undefined) {
    const current = readRunState(workspaceDir, draftId);
    if (current?.publication !== undefined) {
      const stages = [current.publication.registration, current.publication.accounting, current.publication.report];
      const hasReceipt = stages.some((stage) => stage.receipt !== undefined);
      if (hasReceipt) {
        const proposed = result.data.publication;
        if (proposed === undefined) {
          refuse("conflict", `runs.${draftId}.publication`, "publication state cannot be removed after a durable source append receipt");
        }
        if (
          current.publication.source.name !== proposed.source.name
          || current.publication.source.agentKeyRef !== proposed.source.agentKeyRef
        ) {
          refuse("conflict", `runs.${draftId}.publication.source`, "source name and agent key reference are immutable after a durable source append receipt");
        }
        const stageNames = ["registration", "accounting", "report"] as const;
        const rank = { "not-started": 0, "in-progress": 1, complete: 2 } as const;
        for (const stageName of stageNames) {
          const before = current.publication[stageName];
          const after = proposed[stageName];
          if (rank[after.state] < rank[before.state]) {
            refuse("conflict", `runs.${draftId}.publication.${stageName}.state`, "publication stage state cannot move backward after a durable source append receipt");
          }
          if (before.receipt !== undefined && (
            after.receipt?.sourceSequence !== before.receipt.sourceSequence
            || after.receipt.entrySha256 !== before.receipt.entrySha256
          )) {
            refuse("conflict", `runs.${draftId}.publication.${stageName}.receipt`, "a durable source append receipt cannot be removed or changed");
          }
          if (before.receipt !== undefined || before.state === "complete") {
            for (const [role, digest] of Object.entries(before.digests ?? {})) {
              if (after.digests?.[role] !== digest) {
                refuse("conflict", `runs.${draftId}.publication.${stageName}.digests.${role}`, "an established publication-stage digest cannot be removed or changed");
              }
            }
          }
        }
      }
    }
  }
  atomicWriteFileSync(runStatePath(workspaceDir, draftId), JSON.stringify(result.data, null, 2));
}

/**
 * A stable `urn:uuid:` IRI derived from a seed string — the same sha256-derived UUID-shaped
 * construction `benchmarking-run`'s `launch.ts` uses for `deterministicSubmissionUri` (mirrored
 * rather than imported: that helper is a private function, not on the package's public surface).
 */
export function deterministicUuidUri(seed: string): `urn:uuid:${string}` {
  const hex = createHash("sha256").update(seed, "utf8").digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `urn:uuid:${uuid}`;
}

/** Deterministic run-owner IRI for a draft in a workspace (module header). */
export function deriveRunOwner(workspaceCreatedAt: string, draftId: string): `urn:uuid:${string}` {
  return deterministicUuidUri(`https://spec.jinn.network/benchmark-product/run-owner:${workspaceCreatedAt}:${draftId}`);
}

/**
 * sha256 hex digest of the draft spec's canonical JSON (sorted keys, recursively) — reuses the
 * audit journal's `inputsDigest` canonicalization rather than reimplementing it, so the same
 * spec content always digests identically regardless of key insertion order (A2: an edit that
 * changes no field value must not spuriously invalidate a quote).
 */
export function specDigest(spec: DraftSpec): string {
  return inputsDigest(spec);
}
