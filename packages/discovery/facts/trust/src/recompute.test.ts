import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_POLICY_FORMAT,
  AUTHORIZATION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
  deriveStrength,
  recordDigest as trustRecordDigest,
  sealAuthorization,
  sealKeyBinding,
  sealTrustPolicy,
} from "@jinn-network/trust-core";
import type {
  AuthorizationStatement,
  DsseSigner,
  KeyBinding,
  Sha256Digest,
  TrustPolicy,
} from "@jinn-network/trust-core";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import type { ReferencedBytes } from "@jinn-network/record-discovery-protocol";
import { describe, expect, it } from "vitest";

import {
  TRUST_FACTS_RECOMPUTE,
  TRUST_FACTS_RECOMPUTE_V2,
  authorizationRecompute,
  authorizationRecomputeV2,
  keyBindingRecompute,
  keyBindingRecomputeV2,
  trustPolicyRecompute,
} from "./recompute.js";

const noReferencedBytes: ReferencedBytes = {
  async "fetch"() {
    return undefined;
  },
};

// A deterministic fake signer -- the recompute functions never verify
// signatures (that is trust-core's own `verify.ts` job, out of this leaf's
// scope), so any well-formed signature satisfies `sealSignedRecord`.
const fakeSigner: DsseSigner = async () => [
  { signature: new Uint8Array([1, 2, 3, 4]), keyid: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK" },
];

const KEY_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

function fakeDigest(seed: string): Sha256Digest {
  return trustRecordDigest(new TextEncoder().encode(seed));
}

describe("facts/trust recompute functions", () => {
  it("recomputes key-binding record facts straight from the sealed envelope bytes", async () => {
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: "urn:uuid:11111111-1111-1111-1111-111111111111",
      key: { publicKey: "fake-public-key-bytes", keyid: KEY_DID, algorithm: "Ed25519", didKey: KEY_DID },
      voucher: { kind: "oidc-machine", subject: "repo:acme/example:ref:refs/heads/main" },
      relationship: "controls",
      scope: ["bindings"],
      validFrom: "2026-07-28T00:00:00.000Z",
      expiresAt: "2027-07-28T00:00:00.000Z",
      ceremony: { type: "oidc-machine", digest: fakeDigest("ceremony") },
      strength: deriveStrength("oidc-machine"),
      supersedes: fakeDigest("prior-binding"),
      anchors: [],
    };
    const sealed = await sealKeyBinding(binding, fakeSigner);

    const facts = await keyBindingRecompute(sealed.envelopeBytes, noReferencedBytes);
    expect(facts).toEqual({
      agent: binding.agent,
      keyid: binding.key.keyid,
      algorithm: binding.key.algorithm,
      relationship: binding.relationship,
      strength: binding.strength,
      validFrom: binding.validFrom,
      expiresAt: binding.expiresAt,
      supersedes: binding.supersedes,
    });
  });

  it("omits absent optional key-binding fields rather than reporting them undefined", async () => {
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: "urn:uuid:22222222-2222-2222-2222-222222222222",
      key: { publicKey: "fake-public-key-bytes", keyid: KEY_DID, algorithm: "Ed25519", didKey: KEY_DID },
      voucher: { kind: "oidc-machine", subject: "repo:acme/example:ref:refs/heads/main" },
      relationship: "operates",
      scope: ["bindings"],
      validFrom: "2026-07-28T00:00:00.000Z",
      ceremony: { type: "oidc-machine", digest: fakeDigest("ceremony-2") },
      strength: deriveStrength("oidc-machine"),
      anchors: [],
    };
    const sealed = await sealKeyBinding(binding, fakeSigner);

    const facts = await keyBindingRecompute(sealed.envelopeBytes, noReferencedBytes);
    expect(facts).toEqual({
      agent: binding.agent,
      keyid: binding.key.keyid,
      algorithm: binding.key.algorithm,
      relationship: binding.relationship,
      strength: binding.strength,
      validFrom: binding.validFrom,
    });
    expect(facts).not.toHaveProperty("expiresAt");
    expect(facts).not.toHaveProperty("supersedes");
  });

  it("recomputes authorization record facts straight from the sealed envelope bytes", async () => {
    const statement: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: "task", digest: { sha256: "a".repeat(64) } }],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: "urn:uuid:33333333-3333-3333-3333-333333333333",
        audience: "urn:uuid:44444444-4444-4444-4444-444444444444",
        capabilities: ["deliveries"],
        expiry: "2026-08-28T00:00:00.000Z",
        nonce: "nonce-1",
        revocation: fakeDigest("revocation-companion"),
      },
    };
    const sealed = await sealAuthorization(statement, fakeSigner);

    const facts = await authorizationRecompute(sealed.envelopeBytes, noReferencedBytes);
    expect(facts).toEqual({
      issuer: statement.predicate.issuer,
      audience: statement.predicate.audience,
      expiry: statement.predicate.expiry,
      revocation: statement.predicate.revocation,
    });
  });

  it("recomputes trust-policy record facts straight from the sealed envelope bytes", async () => {
    const policy: TrustPolicy = {
      protocol: TRUST_POLICY_FORMAT,
      version: 2,
      predecessor: fakeDigest("policy-v1"),
      purposes: { "adoption-authority": { accepted: ["urn:uuid:55555555-5555-5555-5555-555555555555"], requiredStrength: "strong" } },
      signerSet: { keys: [KEY_DID], threshold: 1 },
      refreshBy: "2026-08-28T00:00:00.000Z",
    };
    const sealed = await sealTrustPolicy(policy, fakeSigner);

    const facts = await trustPolicyRecompute(sealed.envelopeBytes, noReferencedBytes);
    expect(facts).toEqual({
      version: policy.version,
      refreshBy: policy.refreshBy,
      predecessor: policy.predecessor,
    });
  });

  it("recomputes to no facts for bytes that do not conform -- never silently consistent", async () => {
    const bytes = new TextEncoder().encode("{");
    expect(await keyBindingRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await authorizationRecompute(bytes, noReferencedBytes)).toEqual({});
    expect(await trustPolicyRecompute(bytes, noReferencedBytes)).toEqual({});
  });

  it("the FactsRecompute registry resolves each trust kind and nothing else", () => {
    expect(TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.keyBinding)).toBe(keyBindingRecompute);
    expect(TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.authorization)).toBe(authorizationRecompute);
    expect(TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.trustPolicy)).toBe(trustPolicyRecompute);
    expect(TRUST_FACTS_RECOMPUTE.get(RECORD_KINDS.task)).toBeUndefined();
  });
});

describe("facts/trust v2 recompute: the join edges v1 left out", () => {
  it("carries the ceremony evidence and every cited anchor, with real values", async () => {
    const ceremony = fakeDigest("ceremony-v2");
    const anchorOne = fakeDigest("anchor-1");
    const anchorTwo = fakeDigest("anchor-2");
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: "urn:uuid:66666666-6666-6666-6666-666666666666",
      key: { publicKey: "fake-public-key-bytes", keyid: KEY_DID, algorithm: "Ed25519", didKey: KEY_DID },
      voucher: { kind: "oidc-machine", subject: "repo:acme/example:ref:refs/heads/main" },
      relationship: "controls",
      scope: ["bindings"],
      validFrom: "2026-07-28T00:00:00.000Z",
      ceremony: { type: "oidc-machine", digest: ceremony },
      strength: deriveStrength("oidc-machine"),
      anchors: [{ digest: anchorOne }, { digest: anchorTwo }],
    };
    const sealed = await sealKeyBinding(binding, fakeSigner);

    const v1 = await keyBindingRecompute(sealed.envelopeBytes, noReferencedBytes);
    const v2 = await keyBindingRecomputeV2(sealed.envelopeBytes, noReferencedBytes);
    expect(v2).toMatchObject(v1);
    expect(v2["ceremony.digest"]).toBe(ceremony);
    // Order is the record's own, so an ordinal in the edge index means the same anchor twice.
    expect(v2.anchorDigests).toEqual([anchorOne, anchorTwo]);
  });

  it("states an empty anchor list rather than omitting it, since `anchors` is required", async () => {
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: "urn:uuid:77777777-7777-7777-7777-777777777777",
      key: { publicKey: "fake-public-key-bytes", keyid: KEY_DID, algorithm: "Ed25519", didKey: KEY_DID },
      voucher: { kind: "github-human", profile: "https://github.com/example", id: 4242 },
      relationship: "operates",
      scope: ["bindings"],
      validFrom: "2026-07-28T00:00:00.000Z",
      ceremony: { type: "github-human", digest: fakeDigest("ceremony-weak") },
      strength: deriveStrength("github-human"),
      anchors: [],
    };
    const sealed = await sealKeyBinding(binding, fakeSigner);
    const facts = await keyBindingRecomputeV2(sealed.envelopeBytes, noReferencedBytes);
    expect(facts.anchorDigests).toEqual([]);
    expect(facts["ceremony.digest"]).toBe(fakeDigest("ceremony-weak"));
  });

  it("carries the delegation chain and the statement's subjects, lifted into the sha256: spelling", async () => {
    const parentOne = fakeDigest("parent-authorization-1");
    const parentTwo = fakeDigest("parent-authorization-2");
    const statement: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [
        { name: "task", digest: { sha256: "c".repeat(64) } },
        { name: "delivery", digest: { sha256: "d".repeat(64) } },
      ],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: "urn:uuid:88888888-8888-8888-8888-888888888888",
        capabilities: ["deliveries"],
        expiry: "2026-08-28T00:00:00.000Z",
        nonce: "nonce-v2",
        proofs: [parentOne, parentTwo],
        revocation: fakeDigest("revocation-v2"),
      },
    };
    const sealed = await sealAuthorization(statement, fakeSigner);

    const v1 = await authorizationRecompute(sealed.envelopeBytes, noReferencedBytes);
    const v2 = await authorizationRecomputeV2(sealed.envelopeBytes, noReferencedBytes);
    expect(v2).toMatchObject(v1);
    expect(v2.proofs).toEqual([parentOne, parentTwo]);
    // A subject descriptor carries bare hex; every digest fact on these cards carries `sha256:`.
    expect(v2.subjectDigests).toEqual([`sha256:${"c".repeat(64)}`, `sha256:${"d".repeat(64)}`]);
  });

  it("omits the delegation chain on a root authorization but still states its subjects", async () => {
    const statement: AuthorizationStatement = {
      _type: IN_TOTO_STATEMENT_TYPE,
      subject: [{ name: "task", digest: { sha256: "e".repeat(64) } }],
      predicateType: AUTHORIZATION_PREDICATE_TYPE,
      predicate: {
        issuer: "urn:uuid:99999999-9999-9999-9999-999999999999",
        capabilities: ["deliveries"],
        expiry: "2026-08-28T00:00:00.000Z",
        nonce: "nonce-root",
      },
    };
    const sealed = await sealAuthorization(statement, fakeSigner);
    const facts = await authorizationRecomputeV2(sealed.envelopeBytes, noReferencedBytes);
    expect(facts).not.toHaveProperty("proofs");
    expect(facts.subjectDigests).toEqual([`sha256:${"e".repeat(64)}`]);
  });

  it("recomputes to no facts for bytes that do not conform", async () => {
    const bytes = new TextEncoder().encode("{");
    expect(await keyBindingRecomputeV2(bytes, noReferencedBytes)).toEqual({});
    expect(await authorizationRecomputeV2(bytes, noReferencedBytes)).toEqual({});
  });

  it("the v2 registry revises two kinds and falls through to v1 for the trust policy", () => {
    expect(TRUST_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.keyBinding)).toBe(keyBindingRecomputeV2);
    expect(TRUST_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.authorization)).toBe(authorizationRecomputeV2);
    expect(TRUST_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.trustPolicy)).toBe(trustPolicyRecompute);
    expect(TRUST_FACTS_RECOMPUTE_V2.get(RECORD_KINDS.task)).toBeUndefined();
  });
});
