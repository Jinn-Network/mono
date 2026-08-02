// packages/marketplace/pipeline/src/facts-mapper.ts
// SPDX-License-Identifier: MIT

import { RECORD_KINDS_SUBMISSION } from "./facts-mapper-kinds.js";
import type { SubmissionFacts } from "./types.js";

export interface NativeDiscoveryCardProvenance {
  /** Structural on purpose: pipeline stays independent of discovery's package tree. */
  readonly source: { readonly agent: string; readonly name: string };
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  /** Exact signed source high-water that gated this card's admission. */
  readonly signedHighWater: {
    readonly sequence: string;
    readonly entry: `sha256:${string}`;
    readonly issuedAt: string;
    readonly refreshBy: string;
    readonly signature: unknown;
  };
}

/** The structural slice of a discovery announcement this mapper reads. No discovery import. */
export interface AnnouncedSubmissionCard {
  readonly record: { readonly kind: string; readonly digest: `sha256:${string}` };
  readonly facts: Readonly<Record<string, unknown>>;
  /** Chain identity the projector carries alongside the announcement. */
  readonly chain: {
    readonly taskId: bigint;
    readonly submission: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly intendedSpendWei: bigint;
  };
  /** Bridge-era annotation (contract 9). `"legacy"` marks a synthesized card. */
  readonly derivationKind?: "chain" | "legacy";
  /** Present only on `legacy` cards: the anchored manifest digest the venue posted with. */
  readonly legacyManifestDigest?: string;
  /** Native discovery provenance; absent on the explicit legacy adapter path. */
  readonly discovery?: NativeDiscoveryCardProvenance;
}

export type FactsMappingRefusal =
  | "wrong-record-kind"
  | "missing-task-digest"
  | "missing-profile-uri"
  | "legacy-card-without-manifest-digest";

export type FactsMappingResult =
  | { readonly ok: true; readonly facts: SubmissionFacts }
  | { readonly ok: false; readonly reason: FactsMappingRefusal };

export interface FactsMapperOptions {
  /** Estimated AI units for this work kind; the host owns the estimate. */
  readonly estimateAiUnits: (workKind: string) => number;
  /** Whether the operator's predicate should treat this card as runnable at all. */
  readonly runnable?: (card: AnnouncedSubmissionCard) => boolean;
  /** Accept `legacy` derivation cards. Stage 1–4 pass `true`; stage 5 flips it to `false`. */
  readonly acceptLegacyCards: boolean;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapAnnouncedSubmissionToFacts(
  card: AnnouncedSubmissionCard,
  options: FactsMapperOptions,
): FactsMappingResult {
  if (card.record.kind !== RECORD_KINDS_SUBMISSION) {
    return { ok: false, reason: "wrong-record-kind" };
  }
  const legacy = card.derivationKind === "legacy";
  if (legacy && (!options.acceptLegacyCards || card.legacyManifestDigest === undefined)) {
    return { ok: false, reason: "legacy-card-without-manifest-digest" };
  }

  const taskDigest = card.facts["taskDigest"];
  if (!isSha256(taskDigest)) return { ok: false, reason: "missing-task-digest" };

  const profileUri = card.facts["taskProfileUri"];
  if (typeof profileUri !== "string" || profileUri.length === 0) {
    return { ok: false, reason: "missing-profile-uri" };
  }

  const declaredWorkKind = card.facts["workKind"];
  const workKind = legacy
    ? card.legacyManifestDigest!
    : typeof declaredWorkKind === "string" && declaredWorkKind.length > 0
      ? declaredWorkKind
      : profileUri;

  const requirements = isRecord(card.facts["requirements"]) ? card.facts["requirements"] : {};
  const runPinning = isRecord(card.facts["runPinning"])
    ? (card.facts["runPinning"] as SubmissionFacts["runPinning"])
    : undefined;

  return {
    ok: true,
    facts: {
      taskId: card.chain.taskId,
      taskDigest,
      submission: card.chain.submission,
      nonce: card.chain.nonce,
      profileUri,
      requirements,
      runnable: options.runnable?.(card) ?? true,
      intendedSpendWei: card.chain.intendedSpendWei,
      intendedAiUnits: options.estimateAiUnits(workKind),
      workKind,
      ...(runPinning === undefined ? {} : { runPinning }),
      ...(card.legacyManifestDigest === undefined
        ? {}
        : { legacyManifestDigest: card.legacyManifestDigest }),
    },
  };
}
