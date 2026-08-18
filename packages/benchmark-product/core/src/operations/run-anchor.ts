/**
 * `anchor` (anchor-evidence design §7.1): obtains third-party time evidence over one of this
 * run's own sealed records and stores it as an AnchorEvidence record.
 *
 * A separate operation on purpose. `runLock` stays synchronous and no network call enters the
 * critical path of an irreversible approval-gated transition; the lock completes first, and
 * anchoring is a thing that either happens afterwards or does not. `anchor` is audited like every
 * operation but is **not** approval-gated: it moves no funds, changes no lifecycle state, and is
 * reversible by never having happened. Configuring an endpoint is the operator's consent to the
 * disclosure the design's §13 item 7 names.
 *
 * Four disciplines are the whole point of this module:
 *
 * - **The lock anchor refuses after launch, and the check runs twice.** A lock anchor obtained
 *   after dispatch began does not support the claim this feature makes, so `launchedAt` refuses
 *   the operation — and because acquisition does network I/O, a launch that interleaves with it
 *   turns the *store* into the same refusal. Checking once would let a race store a weaker fact
 *   silently, which is exactly worse than refusing.
 * - **Verify before storing.** The proof runs through the same rules the bundle path uses, with
 *   this package's own `node:crypto` ports, before any bytes are written. A stored anchor is never
 *   one nobody checked.
 * - **Write-once per (subject, provider), with one exception.** Anchoring again is a refusal, not
 *   an overwrite. The exception is §6.2's upgrade: the completed form of a pending OpenTimestamps
 *   proof is appended as a NEW record naming the pending one, which stays.
 * - **Nothing derivable is stored.** RunState records the anchor record's digest and nothing about
 *   its status; whether a proof is pending or complete is read from the proof bytes.
 */

import { MATRIX_RECORD_KIND, RUN_RECORD_KIND } from "@jinn-network/benchmarking-records";
import {
  ANCHOR_EVIDENCE_KIND,
  OPENTIMESTAMPS_ANCHOR_PROFILE,
  RFC3161_TSA_ANCHOR_PROFILE,
  createOpenTimestampsProofVerifier,
  createRfc3161AnchorProofVerifier,
  decodeAnchorProofContent,
  parseExactAnchorEvidence,
  sealAnchorEvidence,
} from "@jinn-network/trust-core";
import type { AnchorEvidence, AnchorProofResult, AnchorProofSource } from "@jinn-network/trust-core";
import { nodeCryptoAnchorPorts } from "@colophon-claims/verify";
import {
  anchorProofMediaType,
  encodeAnchorProofContent,
  isProducibleAnchorProfile,
  type ProducibleAnchorProfile,
} from "../anchor/profiles.js";
import {
  createOpenTimestampsProofSource,
  createRfc3161ProofSource,
  type AnchorHttpFetch,
  type OpenTimestampsProofSource,
} from "../anchor/sources.js";
import { refuse } from "../errors.js";
import { requireRunState, writeRunState, type RunAnchor, type RunState } from "../run/state.js";
import { assertWorkspace } from "../workspace/workspace.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export type AnchorSubject = "lock" | "matrix";

export interface RunAnchorInput {
  readonly draftId: string;
  readonly subject: AnchorSubject;
  /** Overrides the draft and workspace configuration for this invocation only. */
  readonly providerProfile?: string;
  readonly endpoint?: string;
}

export interface RunAnchorResult {
  readonly subject: AnchorSubject;
  readonly provider: string;
  /** sha256 hex of the sealed AnchorEvidence record. */
  readonly recordSha256: string;
  /** The digest the anchor covers — this run's own sealed Run or Matrix record. */
  readonly subjectSha256: string;
  readonly subjectKind: string;
  /** Derived at store time from the proof bytes, never stored (§5 rule 5). */
  readonly proofStatus: AnchorProofResult["status"];
  /** Present only when this record is the upgraded form of a pending proof (§6.2). */
  readonly upgradesRecordSha256?: string;
}

export interface RunAnchorDeps {
  /** The transport every source is built on. Injected so no test reaches a network. */
  readonly fetch?: AnchorHttpFetch;
  /** Replaces the built-in sources wholesale, keyed by profile URI. */
  readonly sources?: Readonly<Record<string, AnchorProofSource>>;
  /** Test-only seam between acquisition and the store step — where a launch can interleave. */
  readonly afterObtainBeforeStore?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Configuration resolution (§7.3)
// ---------------------------------------------------------------------------

export interface ResolvedAnchorTarget {
  readonly providerProfile: string;
  readonly endpoint: string;
}

export type AnchorConfigResolution =
  | { readonly kind: "disabled" }
  | { readonly kind: "unconfigured" }
  | { readonly kind: "target"; readonly target: ResolvedAnchorTarget };

/**
 * Per-invocation argument, then per-draft setting, then workspace default — §7.3's order, taken
 * literally, including the part where the invocation comes first.
 *
 * A per-draft `anchoring.enabled: false` turns off the automatic path: the lock-time hook, and any
 * invocation that names nothing itself. It does **not** veto an invocation that explicitly names a
 * provider or an endpoint, because §7.3 puts the flag ahead of the draft setting and §7.2 exists so
 * a standalone `anchor` can retry after a failed lock-time attempt. Reading the disable as absolute
 * would also be a one-way trap: a draft is immutable once locked, so a disabled draft could never
 * be anchored again by any means.
 *
 * An invocation that names an endpoint without a provider (or the reverse) falls back to the
 * configured list for the missing half, so `--endpoint` alone retargets a configured provider
 * rather than silently doing nothing.
 */
export function resolveAnchorConfiguration(input: {
  readonly workspaceAnchoring?: readonly ResolvedAnchorTarget[];
  readonly draftEnabled?: boolean;
  readonly providerProfile?: string;
  readonly endpoint?: string;
}): AnchorConfigResolution {
  const invocationNamesATarget = input.providerProfile !== undefined || input.endpoint !== undefined;
  if (input.draftEnabled === false && !invocationNamesATarget) return { kind: "disabled" };

  const configured = input.workspaceAnchoring ?? [];
  const matching = input.providerProfile === undefined
    ? configured
    : configured.filter((entry) => entry.providerProfile === input.providerProfile);

  const providerProfile = input.providerProfile ?? matching[0]?.providerProfile;
  const endpoint = input.endpoint ?? matching[0]?.endpoint;
  if (providerProfile === undefined || endpoint === undefined) return { kind: "unconfigured" };
  return { kind: "target", target: { providerProfile, endpoint } };
}

/** Reads the workspace + draft halves of the configuration for one draft. */
function readConfiguration(context: OperationContext, draftId: string): {
  readonly workspaceAnchoring: readonly ResolvedAnchorTarget[];
  readonly draftEnabled?: boolean;
} {
  const workspace = assertWorkspace(context.workspaceDir);
  const draft = readDraftDocument(context.workspaceDir, draftId);
  const enabled = draft.spec.anchoring?.enabled;
  return {
    workspaceAnchoring: workspace.anchoring ?? [],
    ...(enabled === undefined ? {} : { draftEnabled: enabled }),
  };
}

// ---------------------------------------------------------------------------
// Subject resolution (§7.1)
// ---------------------------------------------------------------------------

interface ResolvedSubject {
  readonly sha256: string;
  readonly kind: string;
}

/**
 * `subject: "lock"` requires `lockedAt` and `runSha256`, and refuses when `launchedAt` is set. A
 * cancelled run is already past launch and refuses by the same rule.
 *
 * `subject: "matrix"` requires the run closed and `matrixSha256` set; launch state is irrelevant,
 * because a matrix anchor is about a terminal record and says nothing about dispatch order.
 */
function resolveSubject(state: RunState, subject: AnchorSubject, draftId: string): ResolvedSubject {
  if (subject === "lock") {
    if (state.lockedAt === undefined || state.runSha256 === undefined) {
      refuse("illegal-transition", `runs.${draftId}.lockedAt`, "lock the run before anchoring its sealed Run record");
    }
    assertNotLaunched(state, draftId);
    return { sha256: state.runSha256, kind: RUN_RECORD_KIND };
  }
  if (state.closedAt === undefined || state.matrixSha256 === undefined) {
    refuse("illegal-transition", `runs.${draftId}.closedAt`, "close the run before anchoring its sealed Matrix record");
  }
  return { sha256: state.matrixSha256, kind: MATRIX_RECORD_KIND };
}

function assertNotLaunched(state: RunState, draftId: string): void {
  if (state.launchedAt !== undefined) {
    refuse(
      "illegal-transition",
      `runs.${draftId}.launchedAt`,
      "a lock anchor obtained after dispatch began does not support the claim it would be read as; anchor before launch",
    );
  }
}

// ---------------------------------------------------------------------------
// Verification (§7.1 rule 4)
// ---------------------------------------------------------------------------

/**
 * The statuses each profile's acquisition may legitimately reach.
 *
 * §7.1 rule 4 refuses "anything below `present`", and §6.2 requires a pending OpenTimestamps
 * record to be stored so it can later be upgraded — the two read as a contradiction, and §11's
 * pending (family 6) and upgraded-pair (family 9) fixtures settle it: a pending record exists and
 * is carried. The disposition taken here is that rule 4's floor is per profile, being the set of
 * outcomes that profile's own lifecycle admits: `pending` is a terminal dead end for RFC 3161 and
 * therefore refused, and the first half of a two-step lifecycle for OpenTimestamps and therefore
 * admitted. `invalid` is refused everywhere, unconditionally.
 */
const ADMITTED_ACQUISITION_STATUSES: Readonly<Record<ProducibleAnchorProfile, readonly AnchorProofResult["status"][]>> = {
  [RFC3161_TSA_ANCHOR_PROFILE]: ["present", "verified"],
  [OPENTIMESTAMPS_ANCHOR_PROFILE]: ["pending", "present", "verified"],
};

/**
 * Runs the real rules over the acquired bytes.
 *
 * No trust material is supplied: roots and headers are strictly verifier-side configuration, and a
 * producer that trusted its own material here would be grading its own homework. The honest
 * producer-side outcome for a well-formed RFC 3161 token is therefore `present`, never `verified`.
 */
function verifyAcquiredProof(
  profile: ProducibleAnchorProfile,
  subjectSha256: string,
  proofBytes: Uint8Array,
): AnchorProofResult {
  return profile === RFC3161_TSA_ANCHOR_PROFILE
    ? createRfc3161AnchorProofVerifier(nodeCryptoAnchorPorts).verifyProof({ subjectSha256, proofBytes })
    : createOpenTimestampsProofVerifier().verifyProof({ subjectSha256, proofBytes });
}

function requireVerifiable(
  profile: ProducibleAnchorProfile,
  result: AnchorProofResult,
): AnchorProofResult["status"] {
  if (!ADMITTED_ACQUISITION_STATUSES[profile].includes(result.status)) {
    refuse(
      "venue-unverifiable",
      `anchor.${profile}`,
      `the acquired proof verifies as "${result.status}"`
      + `${"reason" in result ? ` — ${result.reason}` : ""}; nothing is stored`,
    );
  }
  return result.status;
}

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

function existingAnchors(state: RunState, subject: AnchorSubject, provider: string): readonly RunAnchor[] {
  return (state.anchors ?? []).filter((anchor) => anchor.subject === subject && anchor.provider === provider);
}

function buildSource(profile: ProducibleAnchorProfile, deps: RunAnchorDeps): AnchorProofSource {
  const injected = deps.sources?.[profile];
  if (injected !== undefined) return injected;
  const options = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  return profile === RFC3161_TSA_ANCHOR_PROFILE
    ? createRfc3161ProofSource(options)
    : createOpenTimestampsProofSource(options);
}

function asUpgradeCapable(source: AnchorProofSource): OpenTimestampsProofSource {
  const candidate = source as Partial<OpenTimestampsProofSource>;
  if (typeof candidate.upgradeProof !== "function") {
    refuse("venue-unavailable", `anchor.${source.profile}`, "the configured source cannot upgrade a pending proof");
  }
  return source as OpenTimestampsProofSource;
}

/** The pending record this acquisition would upgrade, if any — and a `conflict` when the existing
 * anchor is not one an upgrade may follow. */
function resolveUpgradeTarget(
  context: OperationContext,
  state: RunState,
  subject: AnchorSubject,
  profile: ProducibleAnchorProfile,
  subjectSha256: string,
  draftId: string,
): { readonly recordSha256: string; readonly proofBytes: Uint8Array } | undefined {
  const carried = existingAnchors(state, subject, profile);
  if (carried.length === 0) return undefined;

  const conflict = (detail: string): never =>
    refuse("conflict", `runs.${draftId}.anchors`, detail);

  if (profile !== OPENTIMESTAMPS_ANCHOR_PROFILE) {
    return conflict(`this run already carries a ${subject} anchor from ${profile}`);
  }
  // The pending record is the only anchor an upgrade may follow, and only while it is still the
  // open one: a pending record that some later record already names as its predecessor has been
  // upgraded, and upgrading it again would re-derive bytes the workspace already holds.
  const alreadyUpgraded = new Set(
    carried.flatMap((anchor) => anchor.upgradesRecordSha256 === undefined ? [] : [anchor.upgradesRecordSha256]),
  );
  const target = carried
    .filter((anchor) => !alreadyUpgraded.has(anchor.recordSha256))
    .map((anchor) => ({
      recordSha256: anchor.recordSha256,
      proofBytes: decodeAnchorProofContent(
        parseExactAnchorEvidence(getSealedBytes(context.workspaceDir, anchor.recordSha256)).proof.content,
      ),
    }))
    .filter((candidate) => verifyAcquiredProof(profile, subjectSha256, candidate.proofBytes).status === "pending")
    .at(-1);
  if (target === undefined) {
    return conflict(`this run already carries a completed ${subject} anchor from ${profile}`);
  }
  return target;
}

export function runAnchor(
  context: OperationContext,
  input: RunAnchorInput,
  deps: RunAnchorDeps = {},
): Promise<OperationResult<RunAnchorResult>> {
  return operateAsync({
    context,
    action: "anchor",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const { workspaceAnchoring, draftEnabled } = readConfiguration(context, input.draftId);
      const resolution = resolveAnchorConfiguration({
        workspaceAnchoring,
        ...(draftEnabled === undefined ? {} : { draftEnabled }),
        ...(input.providerProfile === undefined ? {} : { providerProfile: input.providerProfile }),
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      });
      if (resolution.kind === "disabled") {
        refuse("venue-unavailable", `drafts.${input.draftId}.anchoring`, "anchoring is disabled for this draft");
      }
      if (resolution.kind === "unconfigured") {
        refuse(
          "venue-unavailable",
          "workspace.anchoring",
          "no anchor provider endpoint resolves — configure one on the workspace or pass it per invocation",
        );
      }
      const { providerProfile, endpoint } = resolution.target;
      if (!isProducibleAnchorProfile(providerProfile)) {
        refuse("venue-unavailable", "workspace.anchoring", `no acquisition source implements ${providerProfile}`);
      }

      const state = requireRunState(context.workspaceDir, input.draftId);
      const subject = resolveSubject(state, input.subject, input.draftId);
      // The record must actually be in the sealed store: `getSealedBytes` re-verifies the digest
      // on read, so an anchor is never obtained over a digest this workspace cannot produce bytes
      // for. A valid proof over a digest no record backs is exactly the §8 "dangling anchor".
      getSealedBytes(context.workspaceDir, subject.sha256);

      const upgrade = resolveUpgradeTarget(
        context,
        state,
        input.subject,
        providerProfile,
        subject.sha256,
        input.draftId,
      );

      const source = buildSource(providerProfile, deps);
      const proofBytes = upgrade === undefined
        ? await source.obtainProof({ subjectSha256: subject.sha256, endpoint })
        : await asUpgradeCapable(source).upgradeProof({
          subjectSha256: subject.sha256,
          proofBytes: upgrade.proofBytes,
        });

      const proofStatus = requireVerifiable(
        providerProfile,
        verifyAcquiredProof(providerProfile, subject.sha256, proofBytes),
      );

      await deps.afterObtainBeforeStore?.();

      // Acquisition did network I/O, so the launch fence is re-read against durable state rather
      // than against the copy this call started with.
      const current = requireRunState(context.workspaceDir, input.draftId);
      if (input.subject === "lock") assertNotLaunched(current, input.draftId);

      const record: AnchorEvidence = {
        kind: ANCHOR_EVIDENCE_KIND,
        subject: { kind: subject.kind, digest: { sha256: subject.sha256 } },
        provider: providerProfile,
        proof: {
          mediaType: anchorProofMediaType(providerProfile),
          content: encodeAnchorProofContent(proofBytes),
        },
      };
      const sealed = sealAnchorEvidence(record);
      const recordSha256 = putSealedBytes(context.workspaceDir, sealed.bytes);

      const entry: RunAnchor = {
        subject: input.subject,
        provider: providerProfile,
        recordSha256,
        ...(upgrade === undefined ? {} : { upgradesRecordSha256: upgrade.recordSha256 }),
      };
      writeRunState(context.workspaceDir, input.draftId, {
        ...current,
        anchors: [...(current.anchors ?? []), entry],
      });

      return {
        subject: input.subject,
        provider: providerProfile,
        recordSha256,
        subjectSha256: subject.sha256,
        subjectKind: subject.kind,
        proofStatus,
        ...(upgrade === undefined ? {} : { upgradesRecordSha256: upgrade.recordSha256 }),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// The lock-flow hook (§7.2)
// ---------------------------------------------------------------------------

export type AnchorAfterLockOutcome =
  | { readonly attempted: false; readonly reason: "disabled" | "unconfigured" }
  | { readonly attempted: true; readonly result: OperationResult<RunAnchorResult> };

/**
 * What a `lock` verb calls once the lock transition has already completed (§7.2).
 *
 * **It never throws.** Any anchor failure is a typed result the verb turns into a note; the lock
 * result and exit code are unaffected. The lock is never blocked or delayed — the transition
 * finished before this ran — though the *verb* then spends up to the bounded acquisition timeout
 * before returning, which is the design's deliberate reading of the never-blocks criterion.
 *
 * When nothing is configured this returns `attempted: false` and no audit entry is written: §7.3
 * requires that absent any configuration nothing is attempted and no warning prints.
 */
export async function anchorAfterLockIfConfigured(
  context: OperationContext,
  draftId: string,
  deps: RunAnchorDeps = {},
): Promise<AnchorAfterLockOutcome> {
  let resolution: AnchorConfigResolution;
  try {
    const { workspaceAnchoring, draftEnabled } = readConfiguration(context, draftId);
    resolution = resolveAnchorConfiguration({
      workspaceAnchoring,
      ...(draftEnabled === undefined ? {} : { draftEnabled }),
    });
  } catch {
    // A workspace or draft this cannot even read is not an anchoring decision to report; the lock
    // that just succeeded has already proved both are readable, so this is unreachable in practice
    // and silent by design rather than by accident.
    return { attempted: false, reason: "unconfigured" };
  }
  if (resolution.kind !== "target") return { attempted: false, reason: resolution.kind };

  try {
    return { attempted: true, result: await runAnchor(context, { draftId, subject: "lock" }, deps) };
  } catch (cause) {
    // `runAnchor` already returns typed refusals rather than throwing; this catch exists so that
    // an unexpected throw still cannot reach a caller whose lock has already succeeded.
    return {
      attempted: true,
      result: {
        ok: false,
        error: { code: "execution", detail: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}
