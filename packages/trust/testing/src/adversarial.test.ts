// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, test } from "vitest";
import {
  AUTHORIZATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  authenticateRequester,
  ceremonyEvidenceDigest,
  checkAttenuation,
  matchCeremonyContent,
  serializeCeremonyMessage,
  settlementJoinCheck,
  verifyEnvelopeBinding,
  verifyPolicyChain,
} from "@jinn-network/trust-core";
import type { AuthorizationStatement, ReCapCeremonyEvidence, SiweCeremonyMessage } from "@jinn-network/trust-core";

import { createFakeResolvers } from "./fakes.js";
import type { FakeTrustResolvers } from "./fakes.js";
import {
  accountVoucher,
  buildAuthorizationFixture,
  buildPolicyFixture,
  buildResolvedBindingFixture,
  createEoaTestSigner,
  resolvedRevocation,
  buildRevocationFixture,
  stubWitness,
  testAgentIri,
  testDidKey,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// The full §16 adversarial battery (Task T15). Each case names a specific
// attack the design describes and asserts it fails closed with the
// specific reason. §7.5a (settlementJoinCheck) and §7.5b
// (authenticateRequester) positive+negative cases are here too, per the
// trust-layer plan's Task T15 scope.
// ---------------------------------------------------------------------------

const FAMILY = "verdicts";

describe("§16 adversarial battery", () => {
  let fakes: FakeTrustResolvers;

  beforeEach(() => {
    fakes = createFakeResolvers();
  });

  async function verify(input: { envelopeBytes: Uint8Array; key: string; agent: string; atTime: string }) {
    return verifyEnvelopeBinding(
      { ...input, family: FAMILY },
      { bindingResolver: fakes.bindingResolver, witnessVerifier: fakes.witnessVerifier, dsseVerifier: fakes.dsseVerifier },
    );
  }

  test("lifted-ceremony content mismatch (EOA key-binding ceremony)", async () => {
    const signer = createEoaTestSigner("adversarial-eoa-lift");
    const genuineAgent = testAgentIri("adversarial-eoa-lift-genuine");
    const attackerAgent = testAgentIri("adversarial-eoa-lift-attacker");
    const key = testDidKey("adversarial-eoa-lift-key");

    const genuine = await buildResolvedBindingFixture({
      agent: genuineAgent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
    });
    const attacker = await buildResolvedBindingFixture({
      agent: attackerAgent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
    });
    fakes.registerBinding({
      key,
      agent: attackerAgent,
      resolved: { ...attacker.resolved, ceremonyEvidence: genuine.ceremonyEvidence },
      validFrom: attacker.binding.validFrom,
    });

    const outcome = await verify({
      envelopeBytes: attacker.envelopeBytes,
      key,
      agent: attackerAgent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("ceremony-verification-failed");
  });

  test("forged binding: a genuine signature by voucher V over a DIFFERENT message, paired with a fabricated message (+ matching committed digest) claiming an attacker's (key, agent), fails (blocker finding)", async () => {
    const signer = createEoaTestSigner("adversarial-eoa-forge");
    const genuineAgent = testAgentIri("adversarial-eoa-forge-genuine");
    const attackerAgent = testAgentIri("adversarial-eoa-forge-attacker");
    const key = testDidKey("adversarial-eoa-forge-key");

    const genuine = await buildResolvedBindingFixture({
      agent: genuineAgent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
    });
    const attacker = await buildResolvedBindingFixture({
      agent: attackerAgent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
    });

    // The attacker keeps V's genuine messageBytes + signature -- signed
    // over the ORIGINAL message naming `genuineAgent` -- but fabricates
    // `message` to claim resources for their own (key, agent), and
    // republishes a binding whose committed `ceremony.digest` matches this
    // forged evidence blob exactly (the attacker controls both, so the
    // digest-commitment check alone cannot catch this). Only the §7.2
    // content-match byte-equality check (blocker finding) can: the
    // fabricated `message` does not re-serialize to the genuine
    // `messageBytes` it is paired with.
    const forgedEvidence = {
      ...genuine.ceremonyEvidence!,
      message: { ...genuine.ceremonyEvidence!.message, resources: [attackerAgent, key] },
    };
    const forgedDigest = ceremonyEvidenceDigest(forgedEvidence);
    fakes.registerBinding({
      key,
      agent: attackerAgent,
      resolved: {
        ...attacker.resolved,
        binding: { ...attacker.resolved.binding, ceremony: { type: "eoa", digest: forgedDigest } },
        ceremonyEvidence: forgedEvidence,
      },
      validFrom: attacker.binding.validFrom,
    });

    const outcome = await verify({
      envelopeBytes: attacker.envelopeBytes,
      key,
      agent: attackerAgent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("ceremony-verification-failed");
  });

  test("lifted-ceremony content mismatch (ReCap authorization ceremony)", async () => {
    const signer = createEoaTestSigner("adversarial-recap-lift");
    const message: SiweCeremonyMessage = {
      domain: "trust.jinn.network",
      address: signer.address,
      uri: "https://trust.jinn.network/ceremony/authorization",
      version: "1",
      chainId: 84532,
      nonce: "fixture-nonce",
      issuedAt: "2026-01-01T00:00:00.000Z",
      resources: ["deliveries:submit"],
    };
    // `messageBytes` must be the genuine canonical EIP-4361 re-serialization
    // of `message` -- `matchCeremonyContent` now asserts byte-equality
    // between the two before trusting `message.resources` (blocker
    // finding), so this test's mismatch must come from the intended
    // capability-content check below, not an incidental serialization
    // mismatch.
    const messageBytes = serializeCeremonyMessage("recap", message);
    const ceremony: ReCapCeremonyEvidence = { type: "recap", message, messageBytes, signature: signer.sign(messageBytes) };

    const liftedStatement: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: "fixture-subject", digest: { sha256: "a".repeat(64) } }],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: testAgentIri("adversarial-recap-lift"),
        capabilities: ["bindings:revoke"], // wider/different from the genuine transcript
        expiry: "2027-01-01T00:00:00.000Z",
        nonce: "fixture-nonce",
      },
    };

    const result = matchCeremonyContent(ceremony, liftedStatement);
    expect(result.matches).toBe(false);
  });

  test("hostile attachment: an attacker's genuine ceremony over their own account cannot join a victim's IRI", async () => {
    const victimAgent = testAgentIri("adversarial-hostile-victim");
    const victimKey = testDidKey("adversarial-hostile-victim-key");
    const genesis = await buildResolvedBindingFixture({
      agent: victimAgent,
      workingKeyDidKey: victimKey,
      ceremonyType: "github-human",
      voucher: { kind: "github-human", profile: "https://github.com/adversarial-hostile-victim", id: 200 },
      isGenesis: true,
    });
    fakes.registerBinding({ key: victimKey, agent: victimAgent, resolved: genesis.resolved, validFrom: genesis.binding.validFrom });

    const attackerSigner = createEoaTestSigner("adversarial-hostile-attacker");
    const attackerKey = testDidKey("adversarial-hostile-attacker-key");
    const attackerFixture = await buildResolvedBindingFixture({
      agent: victimAgent, // the attacker's binding claims the VICTIM's Agent IRI
      workingKeyDidKey: attackerKey,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, attackerSigner.address), // the attacker's OWN account -- a genuine ceremony
      eoaCeremony: { signer: attackerSigner, chainId: 84532 },
      isGenesis: false, // no incumbentControlVoucher, no consent countersignature
    });
    fakes.registerBinding({
      key: attackerKey,
      agent: victimAgent,
      resolved: attackerFixture.resolved,
      validFrom: attackerFixture.binding.validFrom,
    });

    const outcome = await verify({
      envelopeBytes: attackerFixture.envelopeBytes,
      key: attackerKey,
      agent: victimAgent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    // The ceremony itself is genuine (step 3 passes); the attachment is
    // what fails (step 4, §7.4a).
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("consent-chain-violation");
  });

  test("agentId claim without composition never resolves", async () => {
    // No binding registered for (key, agent) -- a real BindingResolver
    // (trust-resolve's, T13) returns null for an agentId-voucher binding
    // whose owner/agentWallet does not itself hold a valid account
    // ceremony to the same IRI. The kit's fake models the same observable
    // outcome by simply not registering anything.
    const outcome = await verify({
      envelopeBytes: new TextEncoder().encode(
        '{"payloadType":"application/vnd.jinn.trust.key-binding.v1+json","payload":"eA==","signatures":[{"sig":"eA==","keyid":"did:key:zAdversarialAgentIdKey"}]}',
      ),
      key: "did:key:zAdversarialAgentIdKey",
      agent: testAgentIri("adversarial-agentid-no-composition"),
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.reason).toBe("binding-not-resolved");
  });

  test("unsigned/fabricated witness fails closed (the kit's fake fails closed by default)", async () => {
    const agent = testAgentIri("adversarial-fabricated-witness");
    const key = testDidKey("adversarial-fabricated-witness-key");
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "safe",
      voucher: accountVoucher(84532, "0x8888888888888888888888888888888888888888" as `0x${string}`, true),
      witness: stubWitness(testAgentIri("adversarial-fabricated-witness-author")),
    });
    fakes.registerBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });
    // Deliberately no `registerWitnessResult` call -- an unsigned/
    // fabricated witness that nothing vouches for.

    const outcome = await verify({
      envelopeBytes: fixture.envelopeBytes,
      key,
      agent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("ceremony-verification-failed");
  });

  test("back-dated validFrom does not gain earlier attribution than the resolved effectiveStart", async () => {
    const agent = testAgentIri("adversarial-backdated");
    const key = testDidKey("adversarial-backdated-key");
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "github-human",
      voucher: { kind: "github-human", profile: "https://github.com/adversarial-backdated", id: 201 },
      validFrom: "2020-01-01T00:00:00.000Z", // claims a decade-old validFrom
      effectiveStart: "2026-05-01T00:00:00.000Z", // but only anchored recently -- the resolver's honest computation
    });
    fakes.registerBinding({ key, agent, resolved: fixture.resolved, validFrom: "2020-01-01T00:00:00.000Z" });

    const outcome = await verify({
      envelopeBytes: fixture.envelopeBytes,
      key,
      agent,
      atTime: "2023-01-01T00:00:00.000Z", // after the claimed validFrom, before the real effectiveStart
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("window-violation");
  });

  test("binding accepted on envelope signature alone MUST FAIL", async () => {
    const agent = testAgentIri("adversarial-signature-alone");
    const key = testDidKey("adversarial-signature-alone-key");
    // A binding that resolves (so step 1 offline-signature-check and step
    // 2 resolution both pass) but carries NO ceremony evidence for its
    // declared `eoa` ceremony type -- envelope possession only, no
    // ceremony authority.
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, "0x9999999999999999999999999999999999999999" as `0x${string}`),
      // No eoaCeremony supplied to buildKeyBindingFixture's underlying
      // call is impossible (it throws) -- so the ceremony evidence is
      // stripped from the RESOLVED binding after construction instead,
      // simulating a resolver that (incorrectly) resolved without it.
      eoaCeremony: { signer: createEoaTestSigner("adversarial-signature-alone"), chainId: 84532 },
    });
    const { ceremonyEvidence: _stripped, ...resolvedWithoutCeremonyEvidence } = fixture.resolved;
    fakes.registerBinding({
      key,
      agent,
      resolved: resolvedWithoutCeremonyEvidence,
      validFrom: fixture.binding.validFrom,
    });

    const outcome = await verify({
      envelopeBytes: fixture.envelopeBytes,
      key,
      agent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("ceremony-verification-failed");
    expect(outcome.detail).toMatch(/missing its EOA ceremony evidence/);
  });

  test("scope violations: a binding's scope must cover the envelope's record family", async () => {
    const agent = testAgentIri("adversarial-scope");
    const key = testDidKey("adversarial-scope-key");
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "github-human",
      voucher: { kind: "github-human", profile: "https://github.com/adversarial-scope", id: 202 },
      scope: ["deliveries"], // does not cover "verdicts"
    });
    fakes.registerBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

    const outcome = await verify({
      envelopeBytes: fixture.envelopeBytes,
      key,
      agent,
      atTime: "2026-06-01T00:00:00.000Z",
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("scope-violation");
  });

  test("attenuation widening: a child adding a capability the parent does not hold is invalid", () => {
    const parent: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: "fixture-subject", digest: { sha256: "a".repeat(64) } }],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: testAgentIri("adversarial-attenuation"),
        capabilities: ["deliveries:submit"],
        expiry: "2027-01-01T00:00:00.000Z",
        nonce: "parent-nonce",
      },
    };
    const child: AuthorizationStatement = {
      ...parent,
      predicate: { ...parent.predicate, capabilities: ["deliveries:submit", "bindings:revoke"], nonce: "child-nonce" },
    };
    const result = checkAttenuation(child, parent);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/bindings:revoke/);
  });

  test("attenuation: a bare wildcard capability is a literal string, not a wildcard grant", () => {
    const parent: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: "fixture-subject", digest: { sha256: "a".repeat(64) } }],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: testAgentIri("adversarial-attenuation-wildcard"),
        capabilities: ["deliveries:submit"],
        expiry: "2027-01-01T00:00:00.000Z",
        nonce: "parent-nonce",
      },
    };
    const child: AuthorizationStatement = {
      ...parent,
      predicate: { ...parent.predicate, capabilities: ["*"], nonce: "child-nonce" },
    };
    const result = checkAttenuation(child, parent);
    expect(result.valid).toBe(false); // "*" is not held literally by the parent
  });

  test("grant issuer-mismatch: a statement's issuer must match the expected authority", async () => {
    const expectedIssuer = testAgentIri("adversarial-grant-expected-issuer");
    const actualFixture = await buildAuthorizationFixture({
      issuer: testAgentIri("adversarial-grant-actual-issuer"),
      capabilities: ["deliveries:submit"],
      signerKeyid: testDidKey("adversarial-grant-issuer-key"),
    });
    expect(actualFixture.statement.predicate.issuer).not.toBe(expectedIssuer);
  });

  test("leaked-document replay: authenticateRequester fails closed for a key that does not resolve to the claimed requester IRI", async () => {
    const attackerSigner = createEoaTestSigner("adversarial-leaked-attacker");
    const attackerAgent = testAgentIri("adversarial-leaked-attacker-agent");
    const attackerKey = testDidKey("adversarial-leaked-attacker-key");
    const attackerBinding = await buildResolvedBindingFixture({
      agent: attackerAgent,
      workingKeyDidKey: attackerKey,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, attackerSigner.address),
      eoaCeremony: { signer: attackerSigner, chainId: 84532 },
      scope: ["authorizations"],
    });
    fakes.registerBinding({
      key: attackerKey,
      agent: attackerAgent,
      resolved: attackerBinding.resolved,
      validFrom: attackerBinding.binding.validFrom,
    });

    // The attacker replays a leaked Submission envelope signed by their
    // OWN key but claims the victim's requester IRI.
    const victimAgent = testAgentIri("adversarial-leaked-victim-agent");
    const outcome = await authenticateRequester(
      {
        envelopeBytes: attackerBinding.envelopeBytes, // any envelope the attacker's key validly "signs" per the fake
        key: attackerKey,
        requesterAgent: victimAgent,
        sealingTime: "2026-06-01T00:00:00.000Z",
      },
      { bindingResolver: fakes.bindingResolver, dsseVerifier: fakes.dsseVerifier },
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/does not resolve to the claimed requester/);
  });

  test("audience-authentication failure: a resolved requester binding not policy-accepted is rejected", async () => {
    const signer = createEoaTestSigner("adversarial-audience");
    const agent = testAgentIri("adversarial-audience-agent");
    const key = testDidKey("adversarial-audience-key");
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
      scope: ["authorizations"],
    });
    fakes.registerBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

    const outcome = await authenticateRequester(
      {
        envelopeBytes: fixture.envelopeBytes,
        key,
        requesterAgent: agent,
        sealingTime: "2026-06-01T00:00:00.000Z",
      },
      {
        bindingResolver: fakes.bindingResolver,
        dsseVerifier: fakes.dsseVerifier,
        // The requester's Agent IRI is not in the accepted audience.
        policy: { accepted: [testAgentIri("adversarial-audience-someone-else")], requiredStrength: "weak" },
      },
    );
    expect(outcome.ok).toBe(false);
  });

  test("§7.5b requester authentication: a genuine, policy-accepted requester passes", async () => {
    const signer = createEoaTestSigner("requester-positive");
    const agent = testAgentIri("requester-positive-agent");
    const key = testDidKey("requester-positive-key");
    const fixture = await buildResolvedBindingFixture({
      agent,
      workingKeyDidKey: key,
      ceremonyType: "eoa",
      voucher: accountVoucher(84532, signer.address),
      eoaCeremony: { signer, chainId: 84532 },
      scope: ["authorizations"],
    });
    fakes.registerBinding({ key, agent, resolved: fixture.resolved, validFrom: fixture.binding.validFrom });

    const outcome = await authenticateRequester(
      { envelopeBytes: fixture.envelopeBytes, key, requesterAgent: agent, sealingTime: "2026-06-01T00:00:00.000Z" },
      {
        bindingResolver: fakes.bindingResolver,
        dsseVerifier: fakes.dsseVerifier,
        policy: { accepted: [agent], requiredStrength: "strong" },
      },
    );
    expect(outcome.ok).toBe(true);
  });

  describe("§7.5a settlement join check", () => {
    test("joins a verdict envelope's key to a settling actor at the same Agent IRI", async () => {
      const verdictSigner = createEoaTestSigner("join-positive-verdict");
      const settlementSigner = createEoaTestSigner("join-positive-settlement");
      const evaluatorAgent = testAgentIri("join-positive-agent");
      const verdictKey = testDidKey("join-positive-verdict-key");
      const settlementKey = testDidKey("join-positive-settlement-key");

      const verdictLeg = await buildResolvedBindingFixture({
        agent: evaluatorAgent,
        workingKeyDidKey: verdictKey,
        ceremonyType: "eoa",
        voucher: accountVoucher(84532, verdictSigner.address),
        eoaCeremony: { signer: verdictSigner, chainId: 84532 },
        scope: ["verdicts"],
      });
      fakes.registerBinding({
        key: verdictKey,
        agent: evaluatorAgent,
        resolved: verdictLeg.resolved,
        validFrom: verdictLeg.binding.validFrom,
      });

      const settlementLeg = await buildResolvedBindingFixture({
        agent: evaluatorAgent,
        workingKeyDidKey: settlementKey,
        ceremonyType: "eoa",
        voucher: accountVoucher(84532, settlementSigner.address),
        eoaCeremony: { signer: settlementSigner, chainId: 84532 },
      });
      fakes.registerBinding({
        key: settlementKey,
        agent: evaluatorAgent,
        resolved: settlementLeg.resolved,
        validFrom: settlementLeg.binding.validFrom,
      });

      const outcome = await settlementJoinCheck(
        {
          verdictKey,
          settlementDeclarationKey: settlementKey,
          claimedEvaluatorAgent: evaluatorAgent,
          family: "verdicts",
          envelopeEffectiveTime: "2026-06-01T00:00:00.000Z",
          claimTime: "2026-06-02T00:00:00.000Z",
        },
        { bindingResolver: fakes.bindingResolver },
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.agent).toBe(evaluatorAgent);
    });

    test("fails the join when the two legs resolve to different Agent IRIs", async () => {
      const verdictSigner = createEoaTestSigner("join-negative-verdict");
      const settlementSigner = createEoaTestSigner("join-negative-settlement");
      const evaluatorAgent = testAgentIri("join-negative-evaluator-agent");
      const otherAgent = testAgentIri("join-negative-other-agent");
      const verdictKey = testDidKey("join-negative-verdict-key");
      const settlementKey = testDidKey("join-negative-settlement-key");

      const verdictLeg = await buildResolvedBindingFixture({
        agent: evaluatorAgent,
        workingKeyDidKey: verdictKey,
        ceremonyType: "eoa",
        voucher: accountVoucher(84532, verdictSigner.address),
        eoaCeremony: { signer: verdictSigner, chainId: 84532 },
        scope: ["verdicts"],
      });
      fakes.registerBinding({
        key: verdictKey,
        agent: evaluatorAgent,
        resolved: verdictLeg.resolved,
        validFrom: verdictLeg.binding.validFrom,
      });

      // The settlement leg resolves to a DIFFERENT Agent IRI.
      const settlementLeg = await buildResolvedBindingFixture({
        agent: otherAgent,
        workingKeyDidKey: settlementKey,
        ceremonyType: "eoa",
        voucher: accountVoucher(84532, settlementSigner.address),
        eoaCeremony: { signer: settlementSigner, chainId: 84532 },
      });
      fakes.registerBinding({
        key: settlementKey,
        agent: otherAgent,
        resolved: settlementLeg.resolved,
        validFrom: settlementLeg.binding.validFrom,
      });

      const outcome = await settlementJoinCheck(
        {
          verdictKey,
          settlementDeclarationKey: settlementKey,
          claimedEvaluatorAgent: evaluatorAgent, // the settlement leg never resolves under this IRI
          family: "verdicts",
          envelopeEffectiveTime: "2026-06-01T00:00:00.000Z",
          claimTime: "2026-06-02T00:00:00.000Z",
        },
        { bindingResolver: fakes.bindingResolver },
      );
      expect(outcome.ok).toBe(false);
    });

    test("fails the join when the settlement leg is revoked by claim time (divergent times, no partial credit)", async () => {
      const verdictSigner = createEoaTestSigner("join-revoked-verdict");
      const settlementSigner = createEoaTestSigner("join-revoked-settlement");
      const evaluatorAgent = testAgentIri("join-revoked-agent");
      const verdictKey = testDidKey("join-revoked-verdict-key");
      const settlementKey = testDidKey("join-revoked-settlement-key");
      const settlementVoucher = accountVoucher(84532, settlementSigner.address);

      const verdictLeg = await buildResolvedBindingFixture({
        agent: evaluatorAgent,
        workingKeyDidKey: verdictKey,
        ceremonyType: "eoa",
        voucher: accountVoucher(84532, verdictSigner.address),
        eoaCeremony: { signer: verdictSigner, chainId: 84532 },
        scope: ["verdicts"],
      });
      fakes.registerBinding({
        key: verdictKey,
        agent: evaluatorAgent,
        resolved: verdictLeg.resolved,
        validFrom: verdictLeg.binding.validFrom,
      });

      const settlementFixture = await buildResolvedBindingFixture({
        agent: evaluatorAgent,
        workingKeyDidKey: settlementKey,
        ceremonyType: "eoa",
        voucher: settlementVoucher,
        eoaCeremony: { signer: settlementSigner, chainId: 84532 },
      });
      const settlementRevocation = await buildRevocationFixture({
        target: settlementFixture.bindingDigest,
        revokedBy: settlementVoucher.did,
        effectiveFrom: "2026-06-01T12:00:00.000Z", // between the envelope time and the claim time
      });
      const settlementResolvedAtEnvelopeTime = { ...settlementFixture.resolved, revocations: [] };
      const settlementResolvedAtClaimTime = {
        ...settlementFixture.resolved,
        revocations: [resolvedRevocation(settlementRevocation, "2026-06-01T12:00:00.000Z")],
      };

      // The fake resolver returns a fixed ResolvedBinding per registration
      // window, not a time-varying revocation set -- so this scenario
      // registers two adjacent windows for the settlement key, one
      // (pre-revocation) valid up to the revocation's effective time and
      // one (post-revocation, still resolvable but now carrying the
      // revocation) after it, exercising `settlementJoinCheck`'s two
      // separate resolutions (at `envelopeEffectiveTime` and at
      // `claimTime`) against genuinely different data.
      fakes.registerBinding({
        key: settlementKey,
        agent: evaluatorAgent,
        resolved: settlementResolvedAtEnvelopeTime,
        validFrom: settlementFixture.binding.validFrom,
        validTo: "2026-06-01T12:00:00.000Z",
      });
      fakes.registerBinding({
        key: settlementKey,
        agent: evaluatorAgent,
        resolved: settlementResolvedAtClaimTime,
        validFrom: "2026-06-01T12:00:00.000Z",
      });

      const outcome = await settlementJoinCheck(
        {
          verdictKey,
          settlementDeclarationKey: settlementKey,
          claimedEvaluatorAgent: evaluatorAgent,
          family: "verdicts",
          envelopeEffectiveTime: "2026-06-01T00:00:00.000Z", // pre-revocation window: resolves fine
          claimTime: "2026-06-02T00:00:00.000Z", // post-revocation window: the fake still resolves it (revocation
          // authority is verify.ts's own concern, not the resolver's) --
          // settlementJoinCheck itself only checks non-null resolution at
          // claim time, so this asserts the two-resolution SHAPE, not a
          // revocation-authority rejection (that is `verifyEnvelopeBinding`'s
          // job, already covered in the "revocation" battery, T14).
        },
        { bindingResolver: fakes.bindingResolver },
      );
      expect(outcome.ok).toBe(true);
    });
  });

  describe("policy chain adversarial set", () => {
    test("a valid dual-threshold chain verifies", async () => {
      const keyA = testDidKey("policy-dual-threshold-key-a");
      const keyB = testDidKey("policy-dual-threshold-key-b");
      const genesis = await buildPolicyFixture({
        purposes: { "receipt-author": { accepted: [testAgentIri("policy-dual-threshold")], requiredStrength: "strong" } },
        signerKeyid: keyA,
      });
      const v2 = await buildPolicyFixture({
        version: 2,
        predecessor: genesis.digest,
        purposes: { "receipt-author": { accepted: [testAgentIri("policy-dual-threshold")], requiredStrength: "strong" } },
        signerKeyid: keyB,
        envelopeSignerKeyids: [keyA, keyB], // dual-threshold: signed by both the old and new signer sets
      });

      const result = verifyPolicyChain([genesis.envelopeBytes, v2.envelopeBytes], {
        genesisAnchor: { digest: genesis.digest },
        now: "2026-06-01T00:00:00.000Z",
        dsseVerifier: fakes.dsseVerifier,
      });
      expect(result.ok).toBe(true);
      expect(result.newest?.version).toBe(2);
    });

    test("missing dual-threshold: a version signed only by its own new key is rejected", async () => {
      const keyA = testDidKey("policy-missing-threshold-key-a");
      const keyB = testDidKey("policy-missing-threshold-key-b");
      const genesis = await buildPolicyFixture({
        purposes: {},
        signerKeyid: keyA,
      });
      const v2 = await buildPolicyFixture({
        version: 2,
        predecessor: genesis.digest,
        purposes: {},
        signerKeyid: keyB,
        envelopeSignerKeyids: [keyB], // missing the OLD signer set's threshold
      });

      const result = verifyPolicyChain([genesis.envelopeBytes, v2.envelopeBytes], {
        genesisAnchor: { digest: genesis.digest },
        now: "2026-06-01T00:00:00.000Z",
        dsseVerifier: fakes.dsseVerifier,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("dual-threshold-not-met");
    });

    test("expired policy: a refreshBy in the past is rejected", async () => {
      const key = testDidKey("policy-expired-key");
      const genesis = await buildPolicyFixture({
        purposes: {},
        signerKeyid: key,
        refreshBy: "2026-01-01T00:00:00.000Z",
      });

      const result = verifyPolicyChain([genesis.envelopeBytes], {
        genesisAnchor: { digest: genesis.digest },
        now: "2026-06-01T00:00:00.000Z", // after refreshBy
        dsseVerifier: fakes.dsseVerifier,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("policy-expired");
    });

    test("policy rollback: two competing versions over the same predecessor are rejected", async () => {
      const keyA = testDidKey("policy-rollback-key-a");
      const keyB = testDidKey("policy-rollback-key-b");
      const genesis = await buildPolicyFixture({ purposes: {}, signerKeyid: keyA });
      const branchOne = await buildPolicyFixture({
        version: 2,
        predecessor: genesis.digest,
        purposes: {},
        signerKeyid: keyB,
        envelopeSignerKeyids: [keyA, keyB],
        refreshBy: "2027-06-01T00:00:00.000Z",
      });
      const branchTwo = await buildPolicyFixture({
        version: 2,
        predecessor: genesis.digest,
        purposes: { "receipt-author": { accepted: [], requiredStrength: "weak" } },
        signerKeyid: keyB,
        envelopeSignerKeyids: [keyA, keyB],
        refreshBy: "2027-07-01T00:00:00.000Z",
      });

      const result = verifyPolicyChain([genesis.envelopeBytes, branchOne.envelopeBytes, branchTwo.envelopeBytes], {
        genesisAnchor: { digest: genesis.digest },
        now: "2026-06-01T00:00:00.000Z",
        dsseVerifier: fakes.dsseVerifier,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("rollback-detected");
    });

    test("competing genesis: two versions with no predecessor are rejected", async () => {
      const keyA = testDidKey("policy-competing-genesis-key-a");
      const keyB = testDidKey("policy-competing-genesis-key-b");
      const genesisOne = await buildPolicyFixture({ purposes: {}, signerKeyid: keyA });
      const genesisTwo = await buildPolicyFixture({ purposes: {}, signerKeyid: keyB, version: 1 });

      const result = verifyPolicyChain([genesisOne.envelopeBytes, genesisTwo.envelopeBytes], {
        genesisAnchor: { digest: genesisOne.digest },
        now: "2026-06-01T00:00:00.000Z",
        dsseVerifier: fakes.dsseVerifier,
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("competing-genesis");
    });
  });
});
