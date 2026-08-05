import { RECORD_KINDS } from '@jinn-network/record-discovery-protocol';

/**
 * Frozen bridge-era kind. It intentionally does not become native Record Discovery authority.
 * Byte-identical to `RECORD_KINDS.submission` since the 2026-08 re-seal collapsed the
 * `records/task-execution/submission/1.0` divergence onto the canonical kind (§4.4 of
 * docs/superpowers/specs/2026-08-04-protocol-vocabulary-audit.md) — derived from the same
 * constant rather than duplicating the literal.
 */
export const LEGACY_SUBMISSION_RECORD_KIND = RECORD_KINDS.submission;

/** Native discovery provenance retained alongside the product-local facts card. */
export interface NativeDiscoveryCardProvenance {
  readonly source: { readonly agent: string; readonly name: string };
  readonly sequence: string;
  readonly entryDigest: `sha256:${string}`;
  readonly signedHighWater: {
    readonly sequence: string;
    readonly entry: `sha256:${string}`;
    readonly issuedAt: string;
    readonly refreshBy: string;
    readonly signature: unknown;
  };
}

/** Product-local card joining a verified announcement to canonical marketplace identity. */
export interface AnnouncedSubmissionCard {
  readonly record: { readonly kind: string; readonly digest: `sha256:${string}` };
  readonly facts: Readonly<Record<string, unknown>>;
  readonly chain: {
    readonly taskId: bigint;
    readonly submission: `urn:uuid:${string}`;
    readonly nonce: string;
    readonly intendedSpendWei: bigint;
  };
  readonly derivationKind?: 'chain' | 'legacy';
  readonly legacyManifestDigest?: string;
  readonly discovery?: NativeDiscoveryCardProvenance;
}

/** Product policy facts; not a reusable marketplace or backend contract. */
export interface SubmissionFacts {
  readonly taskId: bigint;
  readonly taskDigest: `sha256:${string}`;
  readonly submission: `urn:uuid:${string}`;
  readonly nonce: string;
  readonly profileUri: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  readonly runnable: boolean;
  readonly intendedSpendWei: bigint;
  readonly intendedAiUnits: number;
  readonly workKind: string;
  readonly runPinning?: {
    readonly harness?: string;
    readonly model?: string;
    readonly loadout?: string;
    readonly effortFloor?: number;
    readonly isolationPolicy?: string;
  };
  readonly legacyManifestDigest?: string;
}

export type FactsMappingRefusal =
  | 'wrong-record-kind'
  | 'missing-task-digest'
  | 'missing-profile-uri'
  | 'legacy-card-without-manifest-digest';

export type FactsMappingResult =
  | { readonly ok: true; readonly facts: SubmissionFacts }
  | { readonly ok: false; readonly reason: FactsMappingRefusal };

export interface FactsMapperOptions {
  readonly estimateAiUnits: (workKind: string) => number;
  readonly runnable?: (card: AnnouncedSubmissionCard) => boolean;
  readonly acceptLegacyCards: boolean;
}

function isSha256(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Maps verified discovery and chain data into the native operator's policy input. */
export function mapAnnouncedSubmissionToFacts(
  card: AnnouncedSubmissionCard,
  options: FactsMapperOptions,
): FactsMappingResult {
  const legacy = card.derivationKind === 'legacy';
  const expectedKind = legacy ? LEGACY_SUBMISSION_RECORD_KIND : RECORD_KINDS.submission;
  if (card.record.kind !== expectedKind) {
    return { ok: false, reason: 'wrong-record-kind' };
  }
  if (legacy && (!options.acceptLegacyCards || card.legacyManifestDigest === undefined)) {
    return { ok: false, reason: 'legacy-card-without-manifest-digest' };
  }

  const taskDigest = card.facts['taskDigest'];
  if (!isSha256(taskDigest)) return { ok: false, reason: 'missing-task-digest' };

  const profileUri = card.facts['taskProfileUri'];
  if (typeof profileUri !== 'string' || profileUri.length === 0) {
    return { ok: false, reason: 'missing-profile-uri' };
  }

  const declaredWorkKind = card.facts['workKind'];
  const workKind = legacy
    ? card.legacyManifestDigest!
    : typeof declaredWorkKind === 'string' && declaredWorkKind.length > 0
      ? declaredWorkKind
      : profileUri;

  const requirements = isRecord(card.facts['requirements']) ? card.facts['requirements'] : {};
  const runPinning = isRecord(card.facts['runPinning'])
    ? (card.facts['runPinning'] as SubmissionFacts['runPinning'])
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
