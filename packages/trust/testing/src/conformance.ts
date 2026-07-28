// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  validateAuthorization,
  validateKeyBinding,
  validateRevocation,
  validateTrustPolicy,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseChainVerifier,
  WitnessResult,
  WitnessVerifier,
} from "@jinn-network/trust-core";

import type { RegisteredBinding } from "./fakes.js";
import {
  accountVoucher,
  buildAuthorizationFixture,
  buildKeyBindingFixture,
  buildPolicyFixture,
  buildResolvedBindingFixture,
  buildRevocationFixture,
  createEoaTestSigner,
  resolvedRevocation,
  stubWitness,
  testAgentIri,
  testDidKey,
  testSha256Digest,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// The §16 conformance battery: schema validation for the four record
// families, the ceremony goldens (EOA SIWE genuinely re-verified; Safe/
// agentId/OIDC-machine/GitHub-human resolver-trusted per §7.2's design),
// at-time resolution window checks, consent chains, and revocation.
//
// §7.5a's settlement-join check and §7.5b's requester authentication are
// Task T15's adversarial-set scope (plan text); the full §16 adversarial
// bullet list is also T15's. This battery covers the positive/negative
// cases named explicitly for T14 in the trust-layer plan's Milestone 6.
// ---------------------------------------------------------------------------

const FAMILY = "verdicts";

export interface TrustVerificationContractContext {
  readonly bindingResolver: BindingResolver;
  readonly witnessVerifier: WitnessVerifier;
  readonly dsseVerifier: DsseChainVerifier;
  seedBinding(entry: RegisteredBinding): void;
  seedWitnessResult(verifier: string, result: WitnessResult): void;
  cleanup?: () => Promise<void> | void;
}

export type TrustVerificationContractFactory = (
  name: string,
) => Promise<TrustVerificationContractContext> | TrustVerificationContractContext;

export function describeTrustVerificationContract(createContext: TrustVerificationContractFactory): void {
  describe("Trust verification contract", () => {
    let context: TrustVerificationContractContext;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
    });

    afterEach(async () => {
      await context.cleanup?.();
    });

    async function verify(input: {
      readonly envelopeBytes: Uint8Array;
      readonly key: string;
      readonly agent: string;
      readonly atTime: string;
    }) {
      return verifyEnvelopeBinding(
        { ...input, family: FAMILY },
        {
          bindingResolver: context.bindingResolver,
          witnessVerifier: context.witnessVerifier,
          dsseVerifier: context.dsseVerifier,
        },
      );
    }

    // -----------------------------------------------------------------
    // Schema validation (§16).
    // -----------------------------------------------------------------
    describe("schema validation", () => {
      test("a well-formed key-binding record conforms", async () => {
        const fixture = await buildKeyBindingFixture({
          agent: testAgentIri("schema-binding"),
          workingKeyDidKey: testDidKey("schema-binding-key"),
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/fixture-voucher", id: 1 },
        });
        expect(validateKeyBinding(fixture.envelopeBytes).conforms).toBe(true);
      });

      test("strength producer-asserted against the ceremony's derived strength is a conformance failure", async () => {
        const fixture = await buildKeyBindingFixture({
          agent: testAgentIri("schema-binding-strength"),
          workingKeyDidKey: testDidKey("schema-binding-strength-key"),
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/fixture-voucher-2", id: 2 },
          strengthOverride: "strong",
        });
        const report = validateKeyBinding(fixture.envelopeBytes);
        expect(report.conforms).toBe(false);
        expect(report.diagnostics.some((d) => d.code === "STRENGTH_MISMATCH")).toBe(true);
      });

      test("a well-formed revocation record conforms", async () => {
        const fixture = await buildRevocationFixture({
          target: testSha256Digest("schema-revocation-target"),
          revokedBy: "did:pkh:eip155:84532:0x1111111111111111111111111111111111111111",
        });
        expect(validateRevocation(fixture.envelopeBytes).conforms).toBe(true);
      });

      test("a well-formed authorization statement conforms", async () => {
        const fixture = await buildAuthorizationFixture({
          issuer: testAgentIri("schema-authorization"),
          capabilities: ["deliveries:submit"],
          signerKeyid: testDidKey("schema-authorization-key"),
        });
        expect(validateAuthorization(fixture.envelopeBytes).conforms).toBe(true);
      });

      test("a well-formed trust-policy document conforms", async () => {
        const fixture = await buildPolicyFixture({
          purposes: { "receipt-author": { accepted: [testAgentIri("schema-policy")], requiredStrength: "strong" } },
          signerKeyid: testDidKey("schema-policy-key"),
        });
        expect(validateTrustPolicy(fixture.envelopeBytes).conforms).toBe(true);
      });
    });

    // -----------------------------------------------------------------
    // Ceremony goldens (§7.2).
    // -----------------------------------------------------------------
    describe("ceremony goldens", () => {
      test("EOA SIWE: a genuine ceremony with matching content verifies", async () => {
        const signer = createEoaTestSigner("ceremony-eoa");
        const agent = testAgentIri("ceremony-eoa-agent");
        const key = testDidKey("ceremony-eoa-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher: accountVoucher(84532, signer.address),
          eoaCeremony: { signer, chainId: 84532 },
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("EOA SIWE: a lifted ceremony (content mismatch) fails closed", async () => {
        const signer = createEoaTestSigner("ceremony-eoa-lifted");
        const genuineAgent = testAgentIri("ceremony-eoa-lifted-genuine");
        const attackerAgent = testAgentIri("ceremony-eoa-lifted-attacker");
        const key = testDidKey("ceremony-eoa-lifted-key");

        // The genuine ceremony evidence names `genuineAgent`.
        const genuine = await buildKeyBindingFixture({
          agent: genuineAgent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher: accountVoucher(84532, signer.address),
          eoaCeremony: { signer, chainId: 84532 },
        });
        // The attacker's binding claims a different Agent IRI, lifting the
        // genuine ceremony evidence onto it.
        const lifted = await buildResolvedBindingFixture({
          agent: attackerAgent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher: accountVoucher(84532, signer.address),
          eoaCeremony: { signer, chainId: 84532 },
        });
        const resolvedWithLiftedEvidence = { ...lifted.resolved, ceremonyEvidence: genuine.ceremonyEvidence };
        context.seedBinding({
          key,
          agent: attackerAgent,
          resolved: resolvedWithLiftedEvidence,
          validFrom: lifted.binding.validFrom,
        });

        const outcome = await verify({
          envelopeBytes: lifted.envelopeBytes,
          key,
          agent: attackerAgent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe("ceremony-verification-failed");
      });

      test("Safe 1271: a policy-accepted witness verifies", async () => {
        const witnessIri = testAgentIri("ceremony-safe-witness");
        const agent = testAgentIri("ceremony-safe-agent");
        const key = testDidKey("ceremony-safe-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "safe",
          voucher: accountVoucher(84532, "0x5555555555555555555555555555555555555555" as `0x${string}`, true),
          witness: stubWitness(witnessIri),
        });
        context.seedWitnessResult(witnessIri, { verified: true });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("Safe 1271: an unverified witness fails closed", async () => {
        const witnessIri = testAgentIri("ceremony-safe-bad-witness");
        const agent = testAgentIri("ceremony-safe-bad-agent");
        const key = testDidKey("ceremony-safe-bad-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "safe",
          voucher: accountVoucher(84532, "0x6666666666666666666666666666666666666666" as `0x${string}`, true),
          witness: stubWitness(witnessIri),
        });
        context.seedWitnessResult(witnessIri, { verified: false, reason: "witness author not policy-accepted" });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe("ceremony-verification-failed");
      });

      test("agentId composition: a resolver-verified agentId binding resolves (real composition is trust-resolve's job, T13)", async () => {
        const agent = testAgentIri("ceremony-agentid-agent");
        const key = testDidKey("ceremony-agentid-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "agentId",
          voucher: { kind: "agentId", caip19: "eip155:84532/erc721:0x7777777777777777777777777777777777777777/7" },
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("OIDC machine: a resolver-verified anchored-JWKS binding resolves", async () => {
        const agent = testAgentIri("ceremony-oidc-agent");
        const key = testDidKey("ceremony-oidc-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "oidc-machine",
          voucher: { kind: "oidc-machine", subject: "repo:jinn-network/mono:ref:refs/heads/next" },
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("GitHub human: always binds at weak strength", async () => {
        const fixture = await buildKeyBindingFixture({
          agent: testAgentIri("ceremony-github-agent"),
          workingKeyDidKey: testDidKey("ceremony-github-key"),
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/ceremony-fixture", id: 3 },
        });
        expect(fixture.binding.strength).toBe("weak");
      });
    });

    // -----------------------------------------------------------------
    // At-time resolution window checks (§7.3/§7.5 step 4).
    // -----------------------------------------------------------------
    describe("at-time resolution", () => {
      test("rejects atTime before the resolved effectiveStart", async () => {
        const agent = testAgentIri("window-before");
        const key = testDidKey("window-before-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/window-before", id: 4 },
          effectiveStart: "2026-04-01T00:00:00.000Z",
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: "2026-01-01T00:00:00.000Z" });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-02-01T00:00:00.000Z",
        });
        expect(outcome.reason).toBe("window-violation");
      });

      test("rejects atTime after expiresAt", async () => {
        const agent = testAgentIri("window-after");
        const key = testDidKey("window-after-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/window-after", id: 5 },
          expiresAt: "2026-03-01T00:00:00.000Z",
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: "2026-01-01T00:00:00.000Z" });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.reason).toBe("window-violation");
      });

      test("an unresolved (e.g. unanchored) binding fails at step 2", async () => {
        const outcome = await verify({
          envelopeBytes: new TextEncoder().encode('{"payloadType":"x","payload":"eA==","signatures":[{"sig":"eA==","keyid":"did:key:zNeverRegistered"}]}'),
          key: "did:key:zNeverRegistered",
          agent: testAgentIri("window-unresolved"),
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.reason).toBe("binding-not-resolved");
      });

      test("resolves the historically-correct binding across a key rotation", async () => {
        const agent = testAgentIri("rotation-agent");
        const oldKey = testDidKey("rotation-old-key");
        const newKey = testDidKey("rotation-new-key");
        const oldFixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: oldKey,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/rotation", id: 6 },
          validFrom: "2026-01-01T00:00:00.000Z",
        });
        const newFixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: newKey,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/rotation", id: 6 },
          validFrom: "2026-06-01T00:00:00.000Z",
          isGenesis: false,
          incumbentControlVoucher: { kind: "github-human", profile: "https://github.com/rotation", id: 6 },
        });
        context.seedBinding({
          key: oldKey,
          agent,
          resolved: oldFixture.resolved,
          validFrom: "2026-01-01T00:00:00.000Z",
          validTo: "2026-06-01T00:00:00.000Z",
        });
        context.seedBinding({
          key: newKey,
          agent,
          resolved: newFixture.resolved,
          validFrom: "2026-06-01T00:00:00.000Z",
        });

        const oldOutcome = await verify({
          envelopeBytes: oldFixture.envelopeBytes,
          key: oldKey,
          agent,
          atTime: "2026-03-01T00:00:00.000Z",
        });
        expect(oldOutcome.ok).toBe(true);

        const newOutcome = await verify({
          envelopeBytes: newFixture.envelopeBytes,
          key: newKey,
          agent,
          atTime: "2026-08-01T00:00:00.000Z",
        });
        expect(newOutcome.ok).toBe(true);

        // The old key no longer resolves for evidence dated after rotation.
        const staleOutcome = await verify({
          envelopeBytes: oldFixture.envelopeBytes,
          key: oldKey,
          agent,
          atTime: "2026-08-01T00:00:00.000Z",
        });
        expect(staleOutcome.reason).toBe("binding-not-resolved");
      });
    });

    // -----------------------------------------------------------------
    // Consent chains (§7.4a).
    // -----------------------------------------------------------------
    describe("consent chains", () => {
      test("the genesis binding of an Agent IRI stands alone", async () => {
        const agent = testAgentIri("consent-genesis");
        const key = testDidKey("consent-genesis-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/consent-genesis", id: 7 },
          isGenesis: true,
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("self-extension: an incumbent controls voucher matching the new binding's own voucher passes", async () => {
        const agent = testAgentIri("consent-self-extension");
        const key = testDidKey("consent-self-extension-key");
        const voucher = { kind: "github-human" as const, profile: "https://github.com/consent-self-extension", id: 8 };
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher,
          isGenesis: false,
          incumbentControlVoucher: voucher,
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("cross-account consent: a currently bindings-scoped countersigning key passes", async () => {
        const agent = testAgentIri("consent-cross-account");
        const consentKey = testDidKey("consent-cross-account-consenter");
        const newKey = testDidKey("consent-cross-account-new");

        const consenting = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: consentKey,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/consent-cross-account-consenter", id: 9 },
          scope: ["bindings"],
        });
        context.seedBinding({ key: consentKey, agent, resolved: consenting.resolved, validFrom: "2026-01-01T00:00:00.000Z" });

        const newFixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: newKey,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/consent-cross-account-new", id: 10 },
          isGenesis: false,
          consent: { keyid: consentKey, sig: btoa("fixture-consent-signature") },
        });
        context.seedBinding({ key: newKey, agent, resolved: newFixture.resolved, validFrom: newFixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: newFixture.envelopeBytes,
          key: newKey,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("missing consent: a non-genesis binding with neither an incumbent voucher nor a consent countersignature is rejected", async () => {
        const agent = testAgentIri("consent-missing");
        const key = testDidKey("consent-missing-key");
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/consent-missing", id: 11 },
          isGenesis: false,
        });
        context.seedBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe("consent-chain-violation");
      });
    });

    // -----------------------------------------------------------------
    // Revocation (§7.4b).
    // -----------------------------------------------------------------
    describe("revocation", () => {
      test("an authorized (voucher-account) revocation before the evidence time rejects the envelope", async () => {
        const signer = createEoaTestSigner("revocation-authorized");
        const agent = testAgentIri("revocation-authorized-agent");
        const key = testDidKey("revocation-authorized-key");
        const voucher = accountVoucher(84532, signer.address);
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher,
          eoaCeremony: { signer, chainId: 84532 },
        });
        const revocation = await buildRevocationFixture({
          target: fixture.bindingDigest,
          revokedBy: voucher.did,
          effectiveFrom: "2026-02-01T00:00:00.000Z",
        });
        const resolvedWithRevocation = {
          ...fixture.resolved,
          revocations: [resolvedRevocation(revocation, "2026-02-01T00:00:00.000Z")],
        };
        context.seedBinding({ key, agent, resolved: resolvedWithRevocation, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe("revoked");
      });

      test("revocation is never retroactive: evidence dated before the revocation's effective time still attributes", async () => {
        const signer = createEoaTestSigner("revocation-nonretroactive");
        const agent = testAgentIri("revocation-nonretroactive-agent");
        const key = testDidKey("revocation-nonretroactive-key");
        const voucher = accountVoucher(84532, signer.address);
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher,
          eoaCeremony: { signer, chainId: 84532 },
        });
        const revocation = await buildRevocationFixture({
          target: fixture.bindingDigest,
          revokedBy: voucher.did,
          effectiveFrom: "2026-06-01T00:00:00.000Z",
        });
        const resolvedWithRevocation = {
          ...fixture.resolved,
          revocations: [resolvedRevocation(revocation, "2026-06-01T00:00:00.000Z")],
        };
        context.seedBinding({ key, agent, resolved: resolvedWithRevocation, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-03-01T00:00:00.000Z", // before the revocation's effective time
        });
        expect(outcome.ok).toBe(true);
      });

      test("an unauthorized revocation signer does not revoke", async () => {
        const signer = createEoaTestSigner("revocation-unauthorized");
        const agent = testAgentIri("revocation-unauthorized-agent");
        const key = testDidKey("revocation-unauthorized-key");
        const voucher = accountVoucher(84532, signer.address);
        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "eoa",
          voucher,
          eoaCeremony: { signer, chainId: 84532 },
        });
        const revocation = await buildRevocationFixture({
          target: fixture.bindingDigest,
          revokedBy: "did:pkh:eip155:84532:0x9999999999999999999999999999999999999999", // not the voucher
          effectiveFrom: "2026-02-01T00:00:00.000Z",
        });
        const resolvedWithRevocation = {
          ...fixture.resolved,
          revocations: [resolvedRevocation(revocation, "2026-02-01T00:00:00.000Z")],
        };
        context.seedBinding({ key, agent, resolved: resolvedWithRevocation, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(true);
      });

      test("a currently-valid scope:bindings working key can authorize revocation", async () => {
        const agent = testAgentIri("revocation-bindings-key-agent");
        const key = testDidKey("revocation-bindings-key-target");
        const revokerKey = testDidKey("revocation-bindings-key-revoker");

        const revokerFixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: revokerKey,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/revocation-bindings-key", id: 12 },
          scope: ["bindings"],
        });
        context.seedBinding({ key: revokerKey, agent, resolved: revokerFixture.resolved, validFrom: "2026-01-01T00:00:00.000Z" });

        const fixture = await buildResolvedBindingFixture({
          agent,
          workingKeyDidKey: key,
          ceremonyType: "github-human",
          voucher: { kind: "github-human", profile: "https://github.com/revocation-bindings-key-target", id: 13 },
        });
        const revocation = await buildRevocationFixture({
          target: fixture.bindingDigest,
          revokedBy: revokerKey,
          effectiveFrom: "2026-02-01T00:00:00.000Z",
        });
        const resolvedWithRevocation = {
          ...fixture.resolved,
          revocations: [resolvedRevocation(revocation, "2026-02-01T00:00:00.000Z")],
        };
        context.seedBinding({ key, agent, resolved: resolvedWithRevocation, validFrom: fixture.binding.validFrom });

        const outcome = await verify({
          envelopeBytes: fixture.envelopeBytes,
          key,
          agent,
          atTime: "2026-06-01T00:00:00.000Z",
        });
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe("revoked");
      });
    });
  });
}
