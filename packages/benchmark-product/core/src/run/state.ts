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
 * `owner` on newly quoted runs is the stable workspace-held Ed25519 `did:key`, shared with the
 * Record Discovery source. Historical deterministic `urn:uuid:` owners remain schema-readable;
 * `deriveRunOwner` below is retained for that compatibility surface.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { inputsDigest } from "../audit/journal.js";
import type { DraftSpec } from "../domain/draft.js";
import { refuse, refuseWithIssues, type ProductIssue } from "../errors.js";
import { atomicWriteFileSync, readFileIfExistsSync } from "../fs/atomic.js";
import { UPGRADEABLE_ANCHOR_PROFILES, isUpgradeableAnchorProfile } from "../anchor/profiles.js";
import { SUITE_PROTOCOL_IDS } from "../runtime/suite-protocol/comparability.js";
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
  /** Frozen before the first executor attempt, so a crash retry has the identical plan. */
  announcedAt: Rfc3339Schema.optional(),
  /** A completed run registered later is explicitly distinguished from prospective registration. */
  postHoc: z.boolean().optional(),
  /** A durable source append position. Its presence freezes source identity, never its URL. */
  receipt: z.object({
    sourceSequence: z.string().min(1),
    entrySha256: Sha256HexSchema,
  }).optional(),
  /** Frozen source position which bounds the complete accounting input enumeration. */
  sourceCutoff: z.object({
    sourceSequence: z.string().regex(/^\d{16}$/),
    entrySha256: Sha256HexSchema,
  }).optional(),
  /** Exact record/artifact bytes made durable by this stage, keyed by their product role. */
  digests: z.record(z.string(), Sha256HexSchema).optional(),
});

export const PublicationStateSchema = z.object({
  /** Local is the safe default. Prospective mode is an explicit public-before-run intent. */
  mode: z.enum(["local", "prospective"]).optional(),
  source: PublicationSourceSchema,
  registration: PublicationStageSchema,
  accounting: PublicationStageSchema,
  /** Matrix v2 is a later, separately announced record; legacy `matrixSha256` remains untouched. */
  matrixV2: PublicationStageSchema.optional(),
  report: PublicationStageSchema,
}).transform((publication) => ({ ...publication, matrixV2: publication.matrixV2 ?? { state: "not-started" as const } }));

export type PublicationSource = z.infer<typeof PublicationSourceSchema>;
export type PublicationStage = z.infer<typeof PublicationStageSchema>;
export type PublicationState = z.infer<typeof PublicationStateSchema>;

export const DEFAULT_PUBLICATION_SOURCE_NAME = "colophon-benchmarks";
export const DEFAULT_PUBLICATION_AGENT_KEY_REF = "workspace-owner";

/** New managed runs always receive this state at quote time. No stage is implied complete. */
export function createPublicationState(source: Partial<PublicationSource> = {}): PublicationState {
  return {
    mode: "local",
    source: {
      agentKeyRef: source.agentKeyRef ?? DEFAULT_PUBLICATION_AGENT_KEY_REF,
      name: source.name ?? DEFAULT_PUBLICATION_SOURCE_NAME,
      ...(source.publicBaseUrl === undefined ? {} : { publicBaseUrl: source.publicBaseUrl }),
    },
    registration: { state: "not-started" },
    accounting: { state: "not-started" },
    matrixV2: { state: "not-started" },
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

/**
 * One anchor this workspace obtained over one of its own sealed records (anchor-evidence design
 * §7.1 rule 5). It names the AnchorEvidence record's digest and nothing about the anchor's status:
 * whether a proof is pending or complete is readable from the proof bytes, and whether it is valid
 * is derived at verification time — the product never stores a status assertion (§5 rule 5).
 *
 * `upgradesRecordSha256` is the §6.2 exception to write-once: an upgraded OpenTimestamps proof is
 * a NEW record that names the pending record it supersedes. The pending record stays; both may
 * travel in a bundle, and each is reported on its own bytes.
 */
export const RunAnchorSchema = z.object({
  subject: z.enum(["lock", "matrix"]),
  /** The anchor-provider profile URI. */
  provider: z.string().min(1),
  /** sha256 hex of the sealed AnchorEvidence record's exact bytes. */
  recordSha256: Sha256HexSchema,
  /** Present only on the upgraded form of a pending proof; names the record it upgrades. */
  upgradesRecordSha256: Sha256HexSchema.optional(),
});

export type RunAnchor = z.infer<typeof RunAnchorSchema>;

/**
 * The run's `beacon-binding/1` record (issue #2976): the public randomness a sealed run bound
 * itself to, and when. Only the digest and the binding time are stored — the beacon reference, the
 * derived order and the pool digest all live in the sealed record's own bytes, and are re-derived
 * from them on every read by `verifyRunBinding`. Storing a derivable field here would create a
 * second place a binding could be edited without moving the digest it is filed under.
 *
 * Write-once: a run binds to one beacon or to none. Re-binding is re-drawing, which is precisely
 * the post-hoc selection the procedure exists to make impossible.
 */
export const RunBindingRefSchema = z.object({
  /** sha256 hex of the sealed binding record's exact bytes. */
  recordSha256: Sha256HexSchema,
  boundAt: Rfc3339Schema,
});

export type RunBindingRef = z.infer<typeof RunBindingRefSchema>;

/**
 * One additional signed Report v1 identity beyond the canonical `reportSha256`/
 * `reportEnvelopeSha256` pair (packet P5, spec §8.3 option 5) — one per `additionalAnalyses` plan
 * entry, keyed by `(method, version)` so a duplicate registered method can never silently collide
 * (`run/compile.ts`'s `buildAnalysisPlan` already refuses a duplicate at seal time, so this is
 * belt-and-braces, not the primary guarantee). This is the SAME additive-sibling shape already
 * used twice in this file — `matrixSha256`/`matrixV2Sha256` above ("never replaces the legacy
 * Matrix v1 field") and `reportSha256`/`reportPayloadSha256` below ("independent from the legacy
 * Report v1 fields") — so the canonical pair stays untouched and every reader of it (nine
 * non-test files, per the packet's own recon) needs no change.
 */
export const AdditionalReportIdentitySchema = z.object({
  method: z.string().min(1),
  version: z.string().min(1),
  reportSha256: Sha256HexSchema,
  reportEnvelopeSha256: Sha256HexSchema,
});

export type AdditionalReportIdentity = z.infer<typeof AdditionalReportIdentitySchema>;

/**
 * One additional public bundle identity beyond the canonical `bundleIdentity`/
 * `bundleRelativePath`/`bundleChecks` triple (packet P5) — one per additional Report, same
 * `(method, version)` keying and the same additive-sibling posture as `additionalReports` above.
 */
export const AdditionalBundleIdentitySchema = z.object({
  method: z.string().min(1),
  version: z.string().min(1),
  bundleIdentity: Sha256HexSchema,
  bundleRelativePath: z.string().regex(/^artifacts\/[a-z0-9][a-z0-9-]{0,63}\/public-bundles\/[a-f0-9]{64}$/),
  bundleChecks: z.array(z.enum([
    "manifest",
    "evidence-closure",
    "trust",
    "matrix-rederivation",
    "report-verification",
    "claim-consistency",
    "integrity-anchors",
  ])),
});

export type AdditionalBundleIdentity = z.infer<typeof AdditionalBundleIdentitySchema>;

export const RunStateSchema = z.object({
  draftId: z.string().min(1),
  /** sha256 hex of the draft spec's canonical JSON as of the most recent quote (A2). */
  specSha256: Sha256HexSchema,
  /** Stable workspace did:key for new runs; historical absolute owner IRIs remain readable. */
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
  /** sha256 hex of the accounting-bound Matrix v2; never replaces the legacy Matrix v1 field. */
  matrixV2Sha256: Sha256HexSchema.optional(),
  /** sha256 hex of the exact BenchmarkAccounting record. */
  accountingSha256: Sha256HexSchema.optional(),
  /** sha256 hex of the sealed Report record's exact PAYLOAD bytes, set at `report` (BP-13). This
   * is the CANONICAL first report — the one entry `report` always produced before
   * `additionalAnalyses` existed (the primary plan's own selection). */
  reportSha256: Sha256HexSchema.optional(),
  /** sha256 hex of the sealed Report's DSSE ENVELOPE bytes, set at `report` (BP-13). Canonical
   * first report, paired with `reportSha256` above. */
  reportEnvelopeSha256: Sha256HexSchema.optional(),
  /** N-1 additional signed Report v1 identities, one per `additionalAnalyses` plan entry, set at
   * `report` in the SAME invocation as the canonical pair above (packet P5, spec §8.3 option 5).
   * Absent on every RunState written before this field existed and on every run with no
   * `additionalAnalyses`. */
  additionalReports: z.array(AdditionalReportIdentitySchema).optional(),
  /** Signed Report v2 identities. These are independent from the legacy Report v1 fields. */
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
    /** Recorded only by an anchored publication (anchor-evidence design §8). Additive: a receipt
     * written before this closure existed keeps exactly the six names it already had. */
    "integrity-anchors",
  ])).optional(),
  /** N-1 additional public bundle identities, one per additional Report, set at `publish` in the
   * SAME invocation as the canonical `bundleIdentity`/`bundleRelativePath`/`bundleChecks` triple
   * above (packet P5). Absent on every RunState written before this field existed and on every run
   * with no `additionalAnalyses`. */
  additionalBundles: z.array(AdditionalBundleIdentitySchema).optional(),
  publishedAt: Rfc3339Schema.optional(),
  /** Append-only; absent on every workspace that has never anchored (anchor-evidence §7.1). */
  anchors: z.array(RunAnchorSchema).optional(),
  /** Absent on every run that has never bound to public randomness (issue #2976). */
  binding: RunBindingRefSchema.optional(),
  suiteQuote: z.object({
    protocol: z.enum(SUITE_PROTOCOL_IDS).optional(),
    executionConformance: z.boolean(),
    coverage: z.enum(["one_task", "ten_task", "full", "custom"]),
    leaderboardSubmitReady: z.boolean(),
    methodLeaderboardEligible: z.boolean(),
    cellCount: z.string().min(1),
    /** Harbor-family protocols write this; non-Harbor protocols write `harnessVersion` or
     * `inspectVersion` instead. Optional so run states persisted before that split (which all
     * carry `harborVersion`) keep parsing. */
    harborVersion: z.string().min(1).optional(),
    harnessVersion: z.string().min(1).optional(),
    inspectVersion: z.string().min(1).optional(),
    selectedTaskCount: z.number().int().positive(),
    armCount: z.number().int().positive(),
    replicates: z.number().int().positive(),
  }).strict().optional(),
}).superRefine((state, context) => {
  // Write-once per (subject, provider), with §6.2's upgrade as the single exception — the durable
  // half of the rule the `anchor` operation enforces (anchor-evidence design §7.1 rule 1).
  //
  // It lives here rather than only in the operation because the operation's check necessarily runs
  // against a snapshot: acquisition does network I/O, so two concurrent `anchor` calls can both
  // pass it and both reach the store. This invariant is what makes the second one impossible
  // whatever the interleaving, and it holds for any writer rather than only for `runAnchor`.
  const anchorDigests = new Set<string>();
  const digestsByPair = new Map<string, Set<string>>();
  // Predecessors already consumed by an upgrade edge, per pair. Without it, "names an earlier
  // record of the same pair" admits a FORK: [A, B upgrades A, C upgrades A] is well-formed entry by
  // entry and would leave three durable anchors for one pair. A record has at most one successor.
  const upgradedByPair = new Map<string, Set<string>>();
  (state.anchors ?? []).forEach((anchor, index) => {
    // `\u001f` (unit separator) written as an escape, not as a raw byte: it cannot occur in
    // `subject`, whose values are the two enum literals, so no provider string can spell another
    // pair's key — and an invisible control character in source is not reviewable.
    const pairKey = `${anchor.subject}\u001f${anchor.provider}`;
    const earlierOfPair = digestsByPair.get(pairKey) ?? new Set<string>();
    const upgradedOfPair = upgradedByPair.get(pairKey) ?? new Set<string>();

    if (anchor.upgradesRecordSha256 !== undefined) {
      if (!isUpgradeableAnchorProfile(anchor.provider)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", index, "upgradesRecordSha256"],
          message: `anchors from ${anchor.provider} have no upgraded form; only ${UPGRADEABLE_ANCHOR_PROFILES.join(", ")} do`,
        });
      } else if (anchor.upgradesRecordSha256 === anchor.recordSha256) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", index, "upgradesRecordSha256"],
          message: "an anchor cannot upgrade itself",
        });
      } else if (!earlierOfPair.has(anchor.upgradesRecordSha256)) {
        // The upgraded form is appended after the record it supersedes, and supersedes a record
        // over the SAME subject from the SAME provider. An upgrade naming a different pair would
        // be a second anchor wearing the exception's clothes.
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", index, "upgradesRecordSha256"],
          message: "an upgraded anchor must name an earlier recorded anchor over the same subject from the same provider",
        });
      } else if (upgradedOfPair.has(anchor.upgradesRecordSha256)) {
        // A second edge into one predecessor forks the chain. Each fork is well-formed on its own
        // terms — earlier, same pair, not itself — so only the consumed set catches it, and without
        // it the pair ends up carrying three durable anchors under the one-exception rule.
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["anchors", index, "upgradesRecordSha256"],
          message: "that anchor is already upgraded by another recorded anchor; a record has at most one upgraded form",
        });
      }
      upgradedOfPair.add(anchor.upgradesRecordSha256);
      upgradedByPair.set(pairKey, upgradedOfPair);
    } else if (earlierOfPair.size > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchors", index, "provider"],
        message: `this run already carries a ${anchor.subject} anchor from ${anchor.provider}; a second one is admitted only as the upgraded form of an earlier pending proof`,
      });
    }

    if (anchorDigests.has(anchor.recordSha256)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchors", index, "recordSha256"],
        message: "the same anchor record is recorded twice",
      });
    }
    anchorDigests.add(anchor.recordSha256);
    earlierOfPair.add(anchor.recordSha256);
    digestsByPair.set(pairKey, earlierOfPair);
  });
  if ((state.reportPayloadSha256 === undefined) !== (state.reportRecordSha256 === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [state.reportPayloadSha256 === undefined ? "reportPayloadSha256" : "reportRecordSha256"],
      message: "signed Report v2 payload and record identities must be established together",
    });
  }
  // A crash can durably append the Report and advance the stage marker before the two local
  // identities are checkpointed. Keep that state readable so publication.report can reproduce
  // and reconcile the exact bytes; user-facing completion still requires receipt + identities.
}).transform((state) => {
  // PUB-09 temporarily serialized the legacy v1 identities under both name pairs. Such a state
  // predates a completed Report-v2 stage, so normalize those duplicate aliases away in memory.
  // The file is not rewritten merely by reading it. A later v2 publication may then establish
  // its genuinely independent payload/envelope identities without losing the v1 bytes.
  const historicalAliases = state.publication?.report.state !== "complete"
    && state.reportPayloadSha256 !== undefined
    && state.reportPayloadSha256 === state.reportSha256
    && state.reportRecordSha256 !== undefined
    && state.reportRecordSha256 === state.reportEnvelopeSha256;
  if (!historicalAliases) return state;
  const {
    reportPayloadSha256: _historicalPayloadAlias,
    reportRecordSha256: _historicalRecordAlias,
    ...normalized
  } = state;
  return normalized as typeof state;
});

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
    if (current?.reportPayloadSha256 !== undefined && (
      result.data.reportPayloadSha256 !== current.reportPayloadSha256
      || result.data.reportRecordSha256 !== current.reportRecordSha256
    )) {
      refuse("conflict", `runs.${draftId}.reportRecordSha256`, "signed Report v2 identities cannot be removed or changed once established");
    }
    // Anchors are append-only (anchor-evidence design §5 rule 6): an anchor is evidence about
    // exact bytes, so removing or editing a recorded one would silently unsay a fact the workspace
    // already obtained. Anchoring again -- a second provider, an upgraded proof, a re-anchor -- is
    // always a new entry appended after the ones already there.
    //
    // What may be appended is decided by the schema's own write-once-per-(subject, provider) rule
    // above, which every write goes through: this block governs the entries already recorded, that
    // one governs the entries being added. Together they are why no interleaving of two concurrent
    // `anchor` calls can leave two anchors of one pair on disk.
    const recordedAnchors = current?.anchors ?? [];
    if (recordedAnchors.length > 0) {
      const proposedAnchors = result.data.anchors ?? [];
      if (proposedAnchors.length < recordedAnchors.length) {
        refuse("conflict", `runs.${draftId}.anchors`, "a recorded anchor cannot be removed");
      }
      for (const [index, before] of recordedAnchors.entries()) {
        const after = proposedAnchors[index]!;
        if (
          after.subject !== before.subject
          || after.provider !== before.provider
          || after.recordSha256 !== before.recordSha256
          || after.upgradesRecordSha256 !== before.upgradesRecordSha256
        ) {
          refuse("conflict", `runs.${draftId}.anchors.${index}`, "a recorded anchor cannot be changed or reordered");
        }
      }
    }
    // Write-once (issue #2976). The operation checks this too, but its check reads a snapshot and
    // writes later, so two concurrent `bind` calls can both pass it. This is what makes the second
    // one impossible whatever the interleaving, and it holds for any writer rather than only for
    // `runBind`.
    if (current?.binding !== undefined) {
      const proposed = result.data.binding;
      if (proposed === undefined) {
        refuse("conflict", `runs.${draftId}.binding`, "a recorded beacon binding cannot be removed");
      }
      if (
        proposed.recordSha256 !== current.binding.recordSha256
        || proposed.boundAt !== current.binding.boundAt
      ) {
        refuse("conflict", `runs.${draftId}.binding`, "a recorded beacon binding cannot be changed — a run binds once");
      }
    }
    if (current?.publication !== undefined) {
      const stages = [current.publication.registration, current.publication.accounting, current.publication.matrixV2, current.publication.report];
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
        if ((current.publication.mode ?? "local") !== (proposed.mode ?? "local")) {
          refuse("conflict", `runs.${draftId}.publication.mode`, "publication mode is immutable after a durable source append receipt");
        }
        const stageNames = ["registration", "accounting", "matrixV2", "report"] as const;
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
