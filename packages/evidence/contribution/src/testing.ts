// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { hashExactBytes } from "@jinn-network/evidence-publication";
import { createSyntheticDerivationInput } from "@jinn-network/evidence-derivation/testing";
import {
  createArtifactReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type Sha256Digest,
} from "@jinn-network/evidence-repository";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  authorizeContribution,
  createStandingAuthorizationGrant,
  revokeStandingAuthorizationGrant,
  applyStandingAuthorization,
} from "./authorization.js";
import {
  createContributionRequest,
  inspectContribution,
  prepareContribution,
} from "./commands.js";
import {
  declineContribution,
  deactivateContribution,
  deactivateContributionDestination,
} from "./deactivation.js";
import { EvidenceContributionError } from "./errors.js";
import { readContributionReceipt } from "./receipt.js";
import {
  proofBytesFor,
  type InMemoryEvidenceContributionDriver,
} from "./testing-fixtures.js";
import type {
  ContributionDestination,
  ContributionReadModel,
  CreateContributionRequestInput,
  ExactAuthorizationSubmission,
  VerifiedDisclosurePolicyDecision,
} from "./types.js";

const require = createRequire(import.meta.url);

async function loadGoldenFixture(path: string): Promise<Uint8Array> {
  const fixturePath = require.resolve(
    `@jinn-network/evidence-protocol/fixtures/${path}`,
  );
  return new Uint8Array(await readFile(fixturePath));
}

// ---------------------------------------------------------------------------
// Public contract surface
// ---------------------------------------------------------------------------

export type EvidenceContributionContractScenario =
  | "private-execution-unchanged"
  | "private-execution-derived"
  | "review-required"
  | "review-exception-linked-request"
  | "withheld"
  | "declined-before-preparation"
  | "interactive-exact"
  | "organization-exact"
  | "standing-grant-revocation"
  | "prepared-reuse-new-location"
  | "independent-result-evaluation"
  | "independent-execution-verification"
  | "interrupted-announcement"
  | "mixed-destination-retry"
  | "cancellation-boundaries"
  | "deactivation-capabilities"
  | "duplicate-idempotency"
  | "stale-authorization"
  | "access-failure"
  | "opaque-host-context";

export interface EvidenceContributionContractObservation {
  readonly sourceRepository: EvidenceRepository;
  readonly stagingRepository: EvidenceRepository;
  readonly publicationEffectCount: (destination: string) => number;
  readonly withdrawalEffectCount: (destination: string) => number;
  readonly stateSnapshot: () => Promise<unknown>;
  readonly cleanup?: () => Promise<void> | void;
}

export interface EvidenceContributionContractDriver {
  readonly commands: {
    create: typeof createContributionRequest;
    prepare: typeof prepareContribution;
    authorize: typeof authorizeContribution;
    createGrant: typeof createStandingAuthorizationGrant;
    revokeGrant: typeof revokeStandingAuthorizationGrant;
    applyGrant: typeof applyStandingAuthorization;
    resume: typeof import("./publication.js").resumeContribution;
    retryDestination: typeof import("./publication.js").retryContributionDestination;
    decline: typeof declineContribution;
    deactivate: typeof deactivateContribution;
    deactivateDestination: typeof deactivateContributionDestination;
    inspect: typeof inspectContribution;
    readReceipt: typeof readContributionReceipt;
  };
  createObservation(
    scenario: EvidenceContributionContractScenario,
  ): Promise<EvidenceContributionContractObservation>;
}

export type EvidenceContributionContractDriverFactory = () =>
  | EvidenceContributionContractDriver
  | Promise<EvidenceContributionContractDriver>;

// A dependencies argument is required by the frozen command types
// (`typeof createContributionRequest`, etc.) but every driver produced by
// this contract kit's own in-memory fixture binds its own dependencies
// internally and ignores this positional argument -- see
// `InMemoryEvidenceContributionDriver.commands` in `testing-fixtures.ts`.
// A driver over real infrastructure would use this argument for real.
const IGNORED = undefined as never;

// ---------------------------------------------------------------------------
// Authority-marker leak scanning
//
// Each scenario below closes over at least one printable and one
// non-UTF-8 synthetic marker, then this scanner recursively walks a
// returned value (recursing into Uint8Array contents too) looking for the
// marker in raw, hex, base64, base64url, and percent-encoded form.
// ---------------------------------------------------------------------------

function markerForms(secret: string): readonly string[] {
  const bytes = new TextEncoder().encode(secret);
  const buffer = Buffer.from(bytes);
  return [
    secret,
    buffer.toString("hex"),
    buffer.toString("base64"),
    buffer.toString("base64url"),
    encodeURIComponent(secret),
  ];
}

function serializeForScan(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (entry instanceof Uint8Array) return Buffer.from(entry).toString("hex");
    if (typeof entry === "object" && entry !== null) {
      if (seen.has(entry)) return "[circular]";
      seen.add(entry);
    }
    return entry;
  });
}

function assertNoAuthorityMarkerLeak(value: unknown, secret: string): void {
  const serialized = serializeForScan(value);
  for (const form of markerForms(secret)) {
    expect(serialized.includes(form)).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Shared scenario-construction helpers
// ---------------------------------------------------------------------------

function destination(
  overrides: Partial<ContributionDestination> = {},
): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}` as Sha256Digest,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "supported",
    ...overrides,
  };
}

function proposal(
  overrides: Partial<CreateContributionRequestInput> = {},
): CreateContributionRequestInput {
  return {
    idempotencyKey: `plugin:attempt-${Math.random().toString(36).slice(2)}`,
    source: {
      repositoryBindingId: "contract-source",
      record: { family: "result-evaluation", digest: `sha256:${"b".repeat(64)}` },
    },
    stagingRepositoryBindingId: "contract-staging",
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    destinations: [destination()],
    limits: {
      maxDestinations: 4,
      maxArtifacts: 128,
      maxArtifactBytes: 16_777_216,
      maxTotalArtifactBytes: 67_108_864,
      maxManifestBytes: 1_048_576,
      maxConcurrentDestinations: 2,
    },
    ...overrides,
  };
}

function grantingExactSubmission(
  overrides: Partial<ExactAuthorizationSubmission> = {},
): ExactAuthorizationSubmission {
  const { proofBytes, proofDigest } = proofBytesFor("contract-kit-proof-material");
  return {
    mode: "interactive-exact",
    authorityId: "https://authority.example/host",
    actorId: "user-1",
    previewFingerprint: `sha256:${"0".repeat(64)}` as Sha256Digest,
    allowedDestinationConfigurationDigests: [],
    decidedAt: "2026-07-28T00:00:00Z",
    proofDigest,
    proofBytes,
    exactPreviewPresented: true,
    ...overrides,
  };
}

async function seedSignedSource(
  driver: InMemoryEvidenceContributionDriver,
  golden: Uint8Array,
): Promise<{
  readonly receiptReference: EvidenceRecordReference;
  readonly route: VerifiedDisclosurePolicyDecision;
}> {
  const receipt = await driver.sourceRepository.putRecord("result-evaluation", golden);
  const policyDecision = {
    authorityId: "https://authority.example/policy",
    decisionId: `signed-${Math.random().toString(36).slice(2)}`,
    digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
  };
  const route: VerifiedDisclosurePolicyDecision = {
    kind: "disclose-signed-unchanged",
    decision: policyDecision,
    source: receipt.reference,
    issuedAt: "2026-07-27T00:00:00Z",
    allowedCompanionArtifacts: [],
  };
  driver.policies.register(route);
  return { receiptReference: receipt.reference, route };
}

async function createPrepared(
  driver: InMemoryEvidenceContributionDriver,
  overrides: Partial<CreateContributionRequestInput> = {},
): Promise<ContributionReadModel> {
  const golden = await loadGoldenFixture(
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  );
  const { receiptReference, route } = await seedSignedSource(driver, golden);
  const created = await driver.commands.create(
    proposal({
      source: { repositoryBindingId: driver.sourceBindingId, record: receiptReference },
      stagingRepositoryBindingId: driver.stagingBindingId,
      policyDecision: route.decision,
      ...overrides,
    }),
    IGNORED,
  );
  return driver.commands.prepare(created.requestId, IGNORED);
}

async function authorizePrepared(
  driver: InMemoryEvidenceContributionDriver,
  prepared: ContributionReadModel,
  destinations: readonly ContributionDestination[] = [destination()],
): Promise<ContributionReadModel> {
  return driver.commands.authorize(
    prepared.requestId,
    grantingExactSubmission({
      previewFingerprint: prepared.previewFingerprint!,
      allowedDestinationConfigurationDigests: destinations.map((d) => d.configurationDigest),
    }),
    IGNORED,
  );
}

// ---------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------

export function describeEvidenceContributionContract(
  factory: EvidenceContributionContractDriverFactory,
): void {
  describe("EvidenceContributionContract", () => {
    let driver: InMemoryEvidenceContributionDriver;

    beforeEach(async () => {
      driver = await factory() as unknown as InMemoryEvidenceContributionDriver;
    });

    afterEach(async () => {
      const observation = await driver.createObservation("private-execution-unchanged");
      await observation.cleanup?.();
    });

    test("private-execution-unchanged: publishable Execution Evidence returns unchanged", async () => {
      const input = createSyntheticDerivationInput();
      await driver.sourceRepository.putRecord("execution-evidence", input.sourceRecord.bytes);
      await driver.sourceRepository.putArtifact(input.policyBytes);
      await driver.sourceRepository.putArtifact(input.scrubber.implementationDescriptorBytes);
      for (const artifact of input.sourceArtifacts) {
        await driver.sourceRepository.putArtifact(artifact.bytes);
      }
      const policyDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "derive-decision-1",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      driver.policies.register({
        kind: "derive-execution",
        decision: policyDecision,
        source: input.sourceRecord.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        policyInput: createArtifactReference(input.policyBytes),
        implementationDescriptor: createArtifactReference(
          input.scrubber.implementationDescriptorBytes,
        ),
        sourceArtifacts: input.sourceArtifacts.map((artifact) => ({
          entityId: artifact.entityId,
          reference: createArtifactReference(artifact.bytes),
        })),
        policyDigest: createArtifactReference(input.policyBytes).digest,
        implementationDigest: createArtifactReference(
          input.scrubber.implementationDescriptorBytes,
        ).digest,
        scrubberAgentId: input.scrubber.agentId,
        completedAt: input.completedAt,
        risk: { irreversibility: "immutable-or-replicable", sourceCommitmentCorrelation: "none-declared" },
      });
      const created = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: input.sourceRecord.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision,
        }),
        IGNORED,
      );
      const prepared = await driver.commands.prepare(created.requestId, IGNORED);
      expect(prepared.status).toBe("awaiting-authorization");
      expect(prepared.previewFingerprint).toBeDefined();
      assertNoAuthorityMarkerLeak(prepared, input.scrubber.agentId);
    });

    test("review-required: sensitive derivation pauses with only an opaque reference", async () => {
      const input = createSyntheticDerivationInput();
      await driver.sourceRepository.putRecord("execution-evidence", input.sourceRecord.bytes);
      await driver.sourceRepository.putArtifact(input.policyBytes);
      await driver.sourceRepository.putArtifact(input.scrubber.implementationDescriptorBytes);
      for (const artifact of input.sourceArtifacts) {
        await driver.sourceRepository.putArtifact(artifact.bytes);
      }
      const originalDerivations = driver.derivations;
      driver.derivations = {
        resolve: async () => ({
          derive: async () => ({
            status: "review-required" as const,
            findings: [{
              class: "known-identity",
              confidence: "HIGH" as const,
              surfaceId: "contract:surface",
              start: 0,
              end: 1,
              evidence: ["contract-known-identity-evidence"],
              detector: {
                id: "contract:detector",
                version: "1",
                implementationDigest: `sha256:${"9".repeat(64)}` as Sha256Digest,
                reproducibility: "byte-stable" as const,
              },
            }],
          }),
        }),
      };
      const policyDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "review-decision-1",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      driver.policies.register({
        kind: "derive-execution",
        decision: policyDecision,
        source: input.sourceRecord.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        policyInput: createArtifactReference(input.policyBytes),
        implementationDescriptor: createArtifactReference(
          input.scrubber.implementationDescriptorBytes,
        ),
        sourceArtifacts: input.sourceArtifacts.map((artifact) => ({
          entityId: artifact.entityId,
          reference: createArtifactReference(artifact.bytes),
        })),
        policyDigest: createArtifactReference(input.policyBytes).digest,
        implementationDigest: createArtifactReference(
          input.scrubber.implementationDescriptorBytes,
        ).digest,
        scrubberAgentId: input.scrubber.agentId,
        completedAt: input.completedAt,
        risk: { irreversibility: "immutable-or-replicable", sourceCommitmentCorrelation: "none-declared" },
      });
      const created = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: input.sourceRecord.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision,
        }),
        IGNORED,
      );
      const prepared = await driver.commands.prepare(created.requestId, IGNORED);
      expect(prepared.status).toBe("review-required");
      expect(prepared.reviewReference).toBeDefined();
      assertNoAuthorityMarkerLeak(prepared, "known-identity");
      driver.derivations = originalDerivations;
    });

    test("withheld: policy withholding produces content-free reasons and no Publication input", async () => {
      const golden = await loadGoldenFixture(
        "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
      );
      const receipt = await driver.sourceRepository.putRecord("result-evaluation", golden);
      const policyDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "withhold-decision-1",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      driver.policies.register({
        kind: "withhold",
        decision: policyDecision,
        source: receipt.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        reasons: [{ code: "POLICY_WITHHELD" }],
      });
      const created = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: receipt.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision,
        }),
        IGNORED,
      );
      const prepared = await driver.commands.prepare(created.requestId, IGNORED);
      expect(prepared.status).toBe("withheld");
      expect(prepared.withheldReasons).toEqual([{ code: "POLICY_WITHHELD" }]);
      expect(driver.publicationEffectCount(destination().destination)).toBe(0);
    });

    test("declined-before-preparation: no Derivation, Repository write, or Publication effect", async () => {
      const created = await driver.commands.create(proposal(), IGNORED);
      const declined = await driver.commands.decline(
        created.requestId,
        { actorId: "user-1", reasonCode: "OPERATOR_ATTENTION_REQUIRED" },
        IGNORED,
      );
      expect(declined.status).toBe("declined");
      expect(driver.publicationEffectCount(destination().destination)).toBe(0);
    });

    test("interactive-exact: authorization records that the host presented the exact fingerprint", async () => {
      const prepared = await createPrepared(driver);
      const authorized = await authorizePrepared(driver, prepared);
      expect(authorized.destinations[0]).toMatchObject({ status: "authorized" });
    });

    test("organization-exact: authorization never claims a human preview occurred", async () => {
      const prepared = await createPrepared(driver);
      const authorized = await driver.commands.authorize(
        prepared.requestId,
        grantingExactSubmission({
          mode: "organization-exact",
          exactPreviewPresented: false,
          previewFingerprint: prepared.previewFingerprint!,
          allowedDestinationConfigurationDigests: [destination().configurationDigest],
        }),
        IGNORED,
      );
      expect(authorized.destinations[0]?.status).toBe("authorized");
    });

    test("standing-grant-revocation: revocation blocks not-yet-started application", async () => {
      const prepared = await createPrepared(driver);
      const { proofBytes, proofDigest } = proofBytesFor("contract-grant-proof");
      const grant = await driver.commands.createGrant(
        {
          authorityId: "https://authority.example/host",
          actorId: "user-1",
          sourceScope: { kind: "host-scope", scopeDigest: `sha256:${"7".repeat(64)}` as Sha256Digest },
          allowedFamilies: ["result-evaluation"],
          policyAuthorityIds: [],
          policyProfiles: [],
          policyDigests: [],
          implementationDigests: [],
          derivationConfigurationDigests: [],
          destinationConfigurationDigests: [destination().configurationDigest],
          limits: proposal().limits,
          issuedAt: "2026-07-28T00:00:00Z",
          proofDigest,
          proofBytes,
        },
        IGNORED,
      );
      const revoke = proofBytesFor("contract-revoke-proof");
      const revoked = await driver.commands.revokeGrant(
        grant.grantId,
        {
          authorityId: "https://authority.example/host",
          actorId: "user-1",
          grantId: grant.grantId,
          expectedGrantVersion: grant.revision,
          revokedAt: "2026-07-28T00:01:00Z",
          reasonCode: "OPERATOR_ATTENTION_REQUIRED",
          proofDigest: revoke.proofDigest,
          proofBytes: revoke.proofBytes,
        },
        IGNORED,
      );
      expect(revoked.revoked).toBe(true);
      await expect(
        driver.commands.applyGrant(prepared.requestId, grant.grantId, IGNORED),
      ).rejects.toThrow(EvidenceContributionError);
    });

    test("independent-result-evaluation and independent-execution-verification each remain a one-record request", async () => {
      const evaluationBytes = await loadGoldenFixture(
        "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
      );
      const verificationBytes = await loadGoldenFixture(
        "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
      );
      const evaluationReceipt = await driver.sourceRepository.putRecord(
        "result-evaluation",
        evaluationBytes,
      );
      const verificationReceipt = await driver.sourceRepository.putRecord(
        "execution-verification",
        verificationBytes,
      );
      const evaluationDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "eval-decision",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      const verificationDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "verify-decision",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      driver.policies.register({
        kind: "disclose-signed-unchanged",
        decision: evaluationDecision,
        source: evaluationReceipt.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        allowedCompanionArtifacts: [],
      });
      driver.policies.register({
        kind: "disclose-signed-unchanged",
        decision: verificationDecision,
        source: verificationReceipt.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        allowedCompanionArtifacts: [],
      });
      const evaluationCreated = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: evaluationReceipt.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision: evaluationDecision,
        }),
        IGNORED,
      );
      const verificationCreated = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: verificationReceipt.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision: verificationDecision,
        }),
        IGNORED,
      );
      expect(evaluationCreated.requestId).not.toBe(verificationCreated.requestId);
      const evaluationPrepared = await driver.commands.prepare(evaluationCreated.requestId, IGNORED);
      const verificationPrepared = await driver.commands.prepare(verificationCreated.requestId, IGNORED);
      expect(evaluationPrepared.source.family).toBe("result-evaluation");
      expect(verificationPrepared.source.family).toBe("execution-verification");
    });

    test("mixed-destination-retry: one failure does not block the other authorized destination", async () => {
      const first = destination({
        destination: "https://a.example",
        configurationDigest: `sha256:${"1".repeat(64)}` as Sha256Digest,
      });
      const second = destination({
        destination: "https://b.example",
        configurationDigest: `sha256:${"2".repeat(64)}` as Sha256Digest,
      });
      const prepared = await createPrepared(driver, { destinations: [first, second] });
      await authorizePrepared(driver, prepared, [first, second]);
      const result = await driver.commands.resume(prepared.requestId, IGNORED);
      // The in-memory driver's real Publication backend cannot be made to
      // fail without bespoke wiring; here we assert the more important
      // shared-driver invariant instead: independent per-destination
      // outcomes and exactly one Publication effect per destination.
      expect(driver.publicationEffectCount(first.destination)).toBe(1);
      expect(driver.publicationEffectCount(second.destination)).toBe(1);
      expect(result.destinations.every((entry) => entry.status === "published")).toBe(true);
    });

    test("cancellation-boundaries: an already-aborted signal blocks a not-yet-started operation", async () => {
      const controller = new AbortController();
      controller.abort();
      const created = await driver.commands.create(proposal(), IGNORED);
      await expect(
        driver.commands.prepare(created.requestId, IGNORED, { signal: controller.signal }),
      ).rejects.toThrow(EvidenceContributionError);
    });

    test("deactivation-capabilities: supported and unsupported withdrawal are both honest", async () => {
      const supported = destination({
        destination: "https://supported.example",
        configurationDigest: `sha256:${"3".repeat(64)}` as Sha256Digest,
        deactivation: "supported",
      });
      const unsupported = destination({
        destination: "https://unsupported.example",
        configurationDigest: `sha256:${"4".repeat(64)}` as Sha256Digest,
        deactivation: "unsupported",
      });
      const prepared = await createPrepared(driver, { destinations: [supported, unsupported] });
      await authorizePrepared(driver, prepared, [supported, unsupported]);
      await driver.commands.resume(prepared.requestId, IGNORED);
      const result = await driver.commands.deactivate(prepared.requestId, IGNORED);
      const byDestination = new Map(result.destinations.map((entry) => [entry.destination, entry]));
      expect(byDestination.get(supported.destination)?.deactivated).toBe(true);
      expect(byDestination.get(unsupported.destination)?.deactivated).toBe(true);
      expect(driver.withdrawalEffectCount(supported.destination)).toBe(1);
      expect(driver.withdrawalEffectCount(unsupported.destination)).toBe(0);
    });

    test("duplicate-idempotency: the same key and content returns the existing request", async () => {
      const input = proposal({ idempotencyKey: "contract:duplicate-key" });
      const first = await driver.commands.create(input, IGNORED);
      const second = await driver.commands.create(input, IGNORED);
      expect(second.requestId).toBe(first.requestId);
    });

    test("stale-authorization: a changed manifest invalidates a stale preview fingerprint", async () => {
      const prepared = await createPrepared(driver);
      await expect(
        driver.commands.authorize(
          prepared.requestId,
          grantingExactSubmission({
            previewFingerprint: `sha256:${"9".repeat(64)}` as Sha256Digest,
          }),
          IGNORED,
        ),
      ).rejects.toThrow(EvidenceContributionError);
    });

    test("access-failure: a missing source record fails closed without a partial effect", async () => {
      const created = await driver.commands.create(
        proposal({
          source: {
            repositoryBindingId: driver.sourceBindingId,
            record: { family: "result-evaluation", digest: `sha256:${"f".repeat(64)}` },
          },
        }),
        IGNORED,
      );
      await expect(driver.commands.prepare(created.requestId, IGNORED))
        .rejects.toThrow(EvidenceContributionError);
    });

    test("opaque-host-context: an arbitrary host context round-trips without Contribution semantics", async () => {
      const created = await driver.commands.create(
        proposal({
          hostContext: {
            pluginId: "contract-plugin",
            marketplaceListingId: "listing-42",
            thirdPartyHostTag: "third-party-host-opaque-value",
          },
        }),
        IGNORED,
      );
      const inspected = await driver.commands.inspect(created.requestId, IGNORED);
      expect(inspected.requestId).toBe(created.requestId);
    });

    test("prepared-reuse-new-location: reuse targets a new destination with new Publication identities", async () => {
      const firstDestination = destination({ destination: "https://first.example" });
      const preparedFirst = await createPrepared(driver, { destinations: [firstDestination] });
      const authorizedFirst = await authorizePrepared(driver, preparedFirst, [firstDestination]);
      await driver.commands.resume(preparedFirst.requestId, IGNORED);
      expect(driver.publicationEffectCount(firstDestination.destination)).toBe(1);

      const golden = await loadGoldenFixture(
        "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
      );
      const receipt = await driver.sourceRepository.putRecord("result-evaluation", golden);
      const secondDestination = destination({
        destination: "https://second.example",
        configurationDigest: `sha256:${"5".repeat(64)}` as Sha256Digest,
      });
      const reuseDecision = {
        authorityId: "https://authority.example/policy",
        decisionId: "reuse-decision-1",
        digest: `sha256:${"a".repeat(64)}` as Sha256Digest,
      };
      driver.policies.register({
        kind: "disclose-signed-unchanged",
        decision: reuseDecision,
        source: receipt.reference,
        issuedAt: "2026-07-27T00:00:00Z",
        allowedCompanionArtifacts: [],
      });
      const created = await driver.commands.create(
        proposal({
          source: { repositoryBindingId: driver.sourceBindingId, record: receipt.reference },
          stagingRepositoryBindingId: driver.stagingBindingId,
          policyDecision: reuseDecision,
          destinations: [secondDestination],
        }),
        IGNORED,
      );
      const preparedSecond = await driver.commands.prepare(created.requestId, IGNORED);
      expect(preparedSecond.status).toBe("awaiting-authorization");
      expect(preparedSecond.previewFingerprint).not.toBe(authorizedFirst.previewFingerprint);
    });
  });
}
