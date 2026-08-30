import { parseDsseEnvelope } from "@jinn-network/trust-core";
import type {
  BindingResolver,
  DsseChainVerifier,
  KeyBinding,
  ResolvedBinding,
  WitnessVerifier,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";

import { OFFER_RECORD_KIND, OFFER_TRUST_SCOPE } from "./identifiers.js";
import { sealOffer } from "./seal.js";
import { createFixtureOfferSigner, FIXTURE_SIGNER_KEY_ID } from "./testing.js";
import { verifyOffer } from "./verify.js";

const HOLDER = "urn:uuid:11111111-1111-5111-8111-111111111111";
const OTHER_HOLDER = "urn:uuid:22222222-2222-5222-8222-222222222222";
const AT_TIME = "2026-08-01T00:00:00Z";
const SUBJECT = `sha256:${"a".repeat(64)}`;

const offer = {
  kind: OFFER_RECORD_KIND,
  subject: SUBJECT,
  rails: [{
    rail: "https://spec.jinn.network/rails/eip155-8453-erc20-usdc/v1",
    to: "0xdeadbeef",
    amount: "1500000",
  }],
  gate: { uri: "https://gate.example/offers" },
};

// The three ports trust-core injects. `dsseVerifier` trusts every keyid an envelope
// declares — the same posture as the tree's shared fakes, and sound here because these
// cases exercise binding resolution, not curve arithmetic: a rejection is expressed by
// declaring a keyid that does not match the claimed signer.
function fakeDsseVerifier(): DsseChainVerifier {
  return (envelopeBytes) => ({
    validSignerKeyids: parseDsseEnvelope(envelopeBytes).signatures
      .map((signature) => signature.keyid)
      .filter((keyid): keyid is string => keyid !== undefined),
  });
}

const witnessVerifier: WitnessVerifier = {
  async verify1271Witness() {
    return { verified: false, reason: "no witness is vouched for in these cases" };
  },
};

function binding(overrides: Partial<KeyBinding> = {}): KeyBinding {
  return {
    protocol: "https://spec.jinn.network/trust/key-binding/v1",
    agent: HOLDER,
    key: {
      publicKey: "z-public",
      keyid: FIXTURE_SIGNER_KEY_ID,
      algorithm: "ed25519",
      didKey: "did:key:z6MkfixtureHolderWorkingKey",
    },
    voucher: { kind: "oidc-machine", subject: "repo:acme/widget:ref:refs/heads/main" },
    relationship: "operates",
    scope: [OFFER_TRUST_SCOPE],
    validFrom: "2026-01-01T00:00:00Z",
    ceremony: { type: "oidc-machine", digest: `sha256:${"c".repeat(64)}` },
    strength: "strong",
    anchors: [{ digest: `sha256:${"d".repeat(64)}` }],
    ...overrides,
  } as KeyBinding;
}

function resolver(resolved: ResolvedBinding | null): BindingResolver {
  return { async resolveBinding() { return resolved; } };
}

function resolvedBinding(overrides: Partial<KeyBinding> = {}): ResolvedBinding {
  return {
    binding: binding(overrides),
    envelopeBytes: new Uint8Array(),
    bindingDigest: `sha256:${"e".repeat(64)}`,
    effectiveStart: "2026-01-01T00:00:00Z",
    isGenesis: true,
    revocations: [],
  };
}

async function sealed() {
  return sealOffer({ offer, signer: createFixtureOfferSigner() });
}

function deps(bindingResolver: BindingResolver) {
  return { bindingResolver, witnessVerifier, dsseVerifier: fakeDsseVerifier() };
}

describe("verifyOffer", () => {
  test("accepts an offer whose signature resolves to the claimed holder", async () => {
    const { envelopeBytes, digest } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      deps(resolver(resolvedBinding())),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.digest).toBe(digest);
    expect(outcome.holder).toBe(HOLDER);
    expect(outcome.offer.subject).toBe(SUBJECT);
  });

  test("rejects bytes that are not a well-formed sealed offer, before any resolution", async () => {
    let resolveCalls = 0;
    const counting: BindingResolver = {
      async resolveBinding() {
        resolveCalls += 1;
        return resolvedBinding();
      },
    };
    const outcome = await verifyOffer(
      {
        envelopeBytes: new TextEncoder().encode("{}"),
        key: FIXTURE_SIGNER_KEY_ID,
        holder: HOLDER,
        atTime: AT_TIME,
      },
      deps(counting),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("envelope-invalid");
    expect(resolveCalls).toBe(0);
  });

  // The point of the kind: a well-formed offer is not an authorized one.
  test("rejects a structurally perfect offer with no resolvable binding", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      deps(resolver(null)),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("binding-not-resolved");
    // The parse still happened, so a caller can report what was refused.
    expect(outcome.offer?.subject).toBe(SUBJECT);
  });

  test("rejects a signature by a key the envelope does not declare", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: "did:key:zSomeoneElse", holder: HOLDER, atTime: AT_TIME },
      deps(resolver(resolvedBinding())),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("envelope-signature-invalid");
  });

  test("rejects a binding whose scope does not cover offers", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      deps(resolver(resolvedBinding({ scope: ["verdicts"] }))),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("scope-violation");
  });

  test("rejects an offer effective before the binding started", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      {
        envelopeBytes,
        key: FIXTURE_SIGNER_KEY_ID,
        holder: HOLDER,
        atTime: "2025-06-01T00:00:00Z",
      },
      deps(resolver(resolvedBinding())),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("window-violation");
  });

  // A resolver that resolved by key alone would otherwise let the attacker hold an
  // OfferEntry whose holder is the victim, and supersede the victim's genuine offers.
  test("rejects a binding that resolved to an Agent IRI other than the claimed holder", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      deps(resolver(resolvedBinding({ agent: OTHER_HOLDER }))),
    );
    expect(outcome.ok, JSON.stringify(outcome)).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("binding-not-resolved");
    expect(outcome.resolvedBinding?.binding.agent).toBe(OTHER_HOLDER);
  });

  // A dependency outage must never be confusable with a failed identity check.
  test("reports a throwing port as dependency-failed rather than rejecting", async () => {
    const { envelopeBytes } = await sealed();
    const throwing: BindingResolver = {
      async resolveBinding() {
        throw new Error("resolver transport unreachable");
      },
    };
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      deps(throwing),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("dependency-failed");
    expect(outcome.detail).toContain("resolver transport unreachable");
    expect(outcome.offer?.subject).toBe(SUBJECT);
  });

  test("applies the caller's policy to the vouching identity when one is supplied", async () => {
    const { envelopeBytes } = await sealed();
    const outcome = await verifyOffer(
      { envelopeBytes, key: FIXTURE_SIGNER_KEY_ID, holder: HOLDER, atTime: AT_TIME },
      {
        ...deps(resolver(resolvedBinding())),
        policy: { accepted: [OTHER_HOLDER], requiredStrength: "strong" },
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("policy-rejected");
  });
});
