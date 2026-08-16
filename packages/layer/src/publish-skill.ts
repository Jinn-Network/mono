/**
 * Publish a layer-2 `jinn.skill.v1` package as a corpus record
 * (spec/2026-07-06-distillation-v1.md §5, reconciled 2026-07-07 with the
 * shipped #1394 substrate).
 *
 * This is the **distilled-skill producer** #1394 anticipated but did not ship:
 * the artifact payload is the canonical `SkillArtifactV1`
 * (operator/src/types/skill-artifact.ts) with `provenance.kind: 'distilled'` and
 * the DR-2026-07-06 distill fields (`skillKind`, `distillPromptSha256`,
 * `distribution`, `verifiabilityTier`). The stored `skill.skillMd` is rendered
 * WITHOUT the `metadata.jinn` frontmatter block — the structured provenance
 * object is canonical; embedding a second copy would drift (use
 * `buildSkillMarkdown(pkg)` in EXPORT mode to write a standalone SKILL.md).
 *
 * A distilled skill has no trace of its own (its evidence is the referenced
 * layer-1 envelopes in `provenance.sourceEnvelopeCids`), so this publishes a
 * **skill-only wrapper** — unlike the seed path, which attaches the skill
 * alongside the seeded trace via `publish(pending, deps, { skill })`.
 *
 * The wrapper envelope is discriminated as `solverType: 'distilled-skill'`.
 * `role` stays `'capture'` — it is a closed enum (`CanonicalRoleSchema`), so a
 * `'knowledge'` role is unavailable without amending the execution-envelope
 * schema (out of scope). The anchor uses a distinct `skill:<cid>` metadata key
 * so a skill payload is not routed into `captureEnvelopeMeta` enrichment
 * (which requires a trace-envelope artifact).
 *
 * NOTE (producer wiring deferred to Plan A5 — issue #1439): the `skill:<cid>`
 * key requested below is honored by the injected `anchorEnvelope` dep and by
 * the indexer's `parseEnvelopeKey` (which registers `skill` as a fourth kind),
 * but the shipped production anchor wiring (`publishContentV2` → `buildMetadataKey`,
 * whose `ContentKind` union is closed to `envelope|evaluation|capture`) does
 * NOT yet emit it — so a live publish currently anchors under
 * `capture:<cid>`. Extending `ContentKind` to `skill` is the A5 round-trip
 * prerequisite (#1439). Until then the distinct-key / anti-enrichment guarantee
 * holds in tests and in the indexer, not on the live anchor path.
 */
import type {
  CaptureEnvelopeAnchorInput,
  CaptureEnvelopeAnchorResult,
  CapturePublishedBlob,
  LayerCaptureRow,
} from './execution-publish.js';
import {
  buildUnsignedCaptureEnvelope,
  sha256Hex,
} from './execution-publish.js';
import type {
  Artifact,
  SignedEnvelope,
  UnsignedEnvelope,
} from '@jinn-network/core';
import { SignedEnvelopeSchema } from '@jinn-network/core';
import {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  type SkillArtifactV1,
} from '@jinn-network/core';
import { signCanonical } from './signing.js';
import { canonicalJson } from '@jinn-network/core';
import { EMPTY_BUNDLE_SHA256 } from '@jinn-network/core/trajectory';
import { buildSkillMarkdown, type SkillPackage } from './skill-package.js';

const DONATION_ARTIFACT_ENCODING = 'jinn.artifact.donation.v1' as const;
const DEFAULT_PRICE_USDC = '0';
export const SKILL_SOLVER_TYPE = 'distilled-skill' as const;

export interface SkillPublishDeps {
  participant: { safeAddress: `0x${string}`; agentEoa: `0x${string}` };
  signer: { address: `0x${string}`; privateKey?: `0x${string}` };
  clientGitSha: string;
  /** Upload the skill artifact payload (a SkillArtifactV1) as a blob. */
  publishArtifact: (input: { artifactType: string; payload: unknown }) => Promise<CapturePublishedBlob>;
  /** Upload the signed wrapper envelope; its CID is the corpus ref. */
  publishEnvelope: (envelope: SignedEnvelope) => Promise<CapturePublishedBlob>;
  /** Anchor the envelope on-chain (ERC-8004). */
  anchorEnvelope: (input: CaptureEnvelopeAnchorInput) => Promise<CaptureEnvelopeAnchorResult>;
  /** Custom signer (e.g. remote key); default signs with signer.privateKey. */
  signEnvelope?: (unsigned: UnsignedEnvelope) => Promise<SignedEnvelope['signature']>;
  /** Access endpoint recorded on the artifact when the blob has none. */
  defaultArtifactEndpoint?: string;
  now?: () => Date;
}

export interface PublishSkillResult {
  envelopeRef: string;
  anchorTx: `0x${string}` | null;
}

/**
 * Supersede lineage a publish may stamp on a skill record (issue #1462).
 * Lifecycle is *content* — not an injected collaborator — so it rides an
 * optional param, preserving the deps/content seam and keeping every existing
 * 2-arg call site working. Honored at read time only when the successor's
 * operator matches the superseded record's operator (operator/.../consume.ts).
 */
export interface SkillLifecycle {
  /** Envelope/manifest CID of the prior record this one replaces. */
  supersedes?: string;
  /** Pure retirement marker: retires `supersedes` with no replacement. */
  deprecates?: boolean;
}

/** Map the distiller-side SkillPackage onto the canonical SkillArtifactV1. */
export function toSkillArtifactV1(
  pkg: SkillPackage,
  operatorSafeAddress: `0x${string}`,
  lifecycle?: SkillLifecycle,
): SkillArtifactV1 {
  return SkillArtifactV1Schema.parse({
    schemaVersion: SKILL_ARTIFACT_TYPE,
    skill: {
      name: pkg.name,
      description: pkg.description,
      // Canonical stored form: provenance lives ONLY in the structured object
      // below — render the SKILL.md without the metadata.jinn block.
      skillMd: buildSkillMarkdown(pkg, { embedProvenance: false }),
    },
    files: [],
    provenance: {
      kind: 'distilled',
      sourceEnvelopeCids: pkg.jinn.provenance,
      operator: { safeAddress: operatorSafeAddress },
      solverType: SKILL_SOLVER_TYPE,
      ...(pkg.jinn.skillKind !== undefined ? { skillKind: pkg.jinn.skillKind } : {}),
      ...(pkg.jinn.distillPromptSha256 !== undefined
        ? { distillPromptSha256: pkg.jinn.distillPromptSha256 }
        : {}),
      distribution: pkg.jinn.distribution,
      verifiabilityTier: pkg.jinn.verifiabilityTier,
      // Auditability (§5, v0.5): the distilling model + compression-ratio estimates.
      ...(pkg.jinn.distillModel !== undefined ? { distillModel: pkg.jinn.distillModel } : {}),
      ...(pkg.jinn.evidenceTokens !== undefined ? { evidenceTokens: pkg.jinn.evidenceTokens } : {}),
      ...(pkg.jinn.skillTokens !== undefined ? { skillTokens: pkg.jinn.skillTokens } : {}),
      // Supersede lineage (#1462).
      ...(lifecycle?.supersedes !== undefined ? { supersedes: lifecycle.supersedes } : {}),
      ...(lifecycle?.deprecates !== undefined ? { deprecates: lifecycle.deprecates } : {}),
    },
  });
}

export async function publishSkill(
  pkg: SkillPackage,
  deps: SkillPublishDeps,
  lifecycle?: SkillLifecycle,
): Promise<PublishSkillResult> {
  const now = deps.now?.() ?? new Date();
  const skillArtifact = toSkillArtifactV1(pkg, deps.participant.safeAddress, lifecycle);

  const blob = await deps.publishArtifact({
    artifactType: SKILL_ARTIFACT_TYPE,
    payload: skillArtifact,
  });
  // canonicalJson matches the live uploader's serialization (publish-live.ts)
  // and the sibling publish() fallback — JSON.stringify would hash different
  // bytes than were uploaded (key order / whitespace) and break verification.
  const sha256 = blob.sha256 ?? sha256Hex(canonicalJson(skillArtifact));
  const endpoint = blob.endpoint ?? deps.defaultArtifactEndpoint;
  if (!endpoint) {
    throw new Error(`published skill artifact ${blob.cid} has no access endpoint (set defaultArtifactEndpoint)`);
  }

  const artifact: Artifact = {
    artifactType: SKILL_ARTIFACT_TYPE,
    sha256,
    metadata: { description: `Distilled skill: ${pkg.name}` },
    access: { endpoint, priceUsdc: blob.priceUsdc ?? DEFAULT_PRICE_USDC },
    sources: [{ kind: 'ipfs', cid: blob.cid, sha256, encoding: DONATION_ARTIFACT_ENCODING }],
  };

  // A skill carries no capture spans; synthesise the minimal PendingCaptureRow
  // the envelope builder reads for provenance. The resulting wrapper carries a
  // cosmetic `payload.capture` block (sessionId `skill:<name>`, spanCount 0) —
  // an artifact of reusing the capture builder; consumers discriminate on
  // solverType/artifactType, never on that block.
  //
  // Ledger note: unlike publish(), no contribution-ledger entry is written
  // here — a distilled skill derives from ALREADY-consented, already-ledgered
  // evidence (its sourceEnvelopeCids); there is no fresh consent event to
  // record. Revisit if skills ever gain their own consent surface.
  const captureRow: LayerCaptureRow = {
    sessionId: `skill:${pkg.name}`,
    capturedAt: now.toISOString(),
    originatingTool: { name: 'jinn-distiller', version: '0.1.0' },
    capturePath: 'A',
    spanCount: 0,
    redactedSpanCount: 0,
    durationMs: 0,
  };

  const unsigned = buildUnsignedCaptureEnvelope({
    capture: captureRow,
    now,
    participant: deps.participant,
    signerAddress: deps.signer.address,
    clientGitSha: deps.clientGitSha,
    artifacts: [artifact],
    harnessBundleSha: EMPTY_BUNDLE_SHA256,
    solverType: SKILL_SOLVER_TYPE,
    role: 'capture',
  });

  const signature = deps.signEnvelope
    ? await deps.signEnvelope(unsigned)
    : await signWithPrivateKey(unsigned, deps);
  const envelope = SignedEnvelopeSchema.parse({ ...unsigned, signature });

  const envelopeBlob = await deps.publishEnvelope(envelope);
  const envelopeRef = envelopeBlob.cid;
  const anchor = await deps.anchorEnvelope({
    metadataKey: `skill:${envelopeRef}`,
    envelopeCid: envelopeRef,
    envelopeHash: envelope.signature.hash as `0x${string}`,
    envelope,
  });

  return { envelopeRef, anchorTx: anchor.txHash ?? null };
}

async function signWithPrivateKey(
  unsigned: UnsignedEnvelope,
  deps: SkillPublishDeps,
): Promise<SignedEnvelope['signature']> {
  if (!deps.signer.privateKey) {
    throw new Error('publishSkill() requires signer.privateKey or a signEnvelope dependency');
  }
  const signed = await signCanonical(unsigned, deps.signer.privateKey, deps.signer.address);
  return { algo: 'secp256k1', signer: signed.signer, hash: signed.hash, sig: signed.sig };
}
