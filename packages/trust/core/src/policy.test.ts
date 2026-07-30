import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import type { DsseProducedSignature, DsseSigner } from "./dsse.js";
import { parseDsseEnvelope } from "./dsse.js";
import {
  POLICY_PURPOSES,
  TrustPolicySchema,
  sealTrustPolicy,
  verifyPolicyChain,
  type DsseChainVerifier,
  type TrustPolicy,
} from "./policy.js";

function loadFixture(dir: string, name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/${dir}/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

const GENESIS_TEMPLATE = loadFixture("policy-chain-v1", "genesis.json") as Omit<TrustPolicy, "predecessor">;
const V2_TEMPLATE = loadFixture("policy-chain-v1", "v2.json") as Omit<TrustPolicy, "predecessor">;
const V3_TEMPLATE = loadFixture("policy-chain-v1", "v3.json") as Omit<TrustPolicy, "predecessor">;

/** A signer that returns one signature per requested keyid -- simulates
 * several co-signers producing one multi-signature DSSE envelope. */
function multiSigner(keyids: readonly string[]): DsseSigner {
  return async () =>
    keyids.map((keyid, index) => ({
      signature: new Uint8Array([index + 1]),
      keyid,
    })) as [DsseProducedSignature, ...DsseProducedSignature[]];
}

/** Trusts every keyid an envelope's own signatures claim -- policy.ts is
 * I/O-free and does not perform cryptographic verification itself; a real
 * host injects a `dsseVerifier` backed by actual signature checks. This
 * fake exists purely to drive `verifyPolicyChain`'s threshold/chain logic
 * in tests, per its documented injected-port design (T7 finding). */
const trustingDsseVerifier: DsseChainVerifier = (envelopeBytes) => {
  const parsed = parseDsseEnvelope(envelopeBytes);
  return {
    validSignerKeyids: parsed.signatures.flatMap((signature) =>
      signature.keyid === undefined ? [] : [signature.keyid],
    ),
  };
};

const NOW = "2026-07-28T00:00:00Z";

describe("TrustPolicySchema / POLICY_PURPOSES", () => {
  test("registers the 9 core policy purposes", () => {
    expect([...POLICY_PURPOSES].sort()).toEqual(
      [
        "adoption-authority",
        "admission-agent",
        "verifier-agent",
        "witness-verifier",
        "parser-registry",
        "receipt-author",
        "plugin-signer",
        "dispatcher-author",
        "evaluator-eligibility",
      ].sort(),
    );
  });

  test("a valid genesis policy document parses", () => {
    expect(TrustPolicySchema.safeParse(GENESIS_TEMPLATE).success).toBe(true);
  });

  test("purpose keys accept namespaced extensions beyond the core 9", () => {
    const withExtension = {
      protocol: GENESIS_TEMPLATE.protocol,
      version: GENESIS_TEMPLATE.version,
      signerSet: GENESIS_TEMPLATE.signerSet,
      refreshBy: GENESIS_TEMPLATE.refreshBy,
      purposes: {
        "verifier-agent": {
          accepted: ["urn:uuid:22222222-2222-4222-8222-222222222222"],
          requiredStrength: "strong",
        },
        "acme:custom-purpose": {
          accepted: ["urn:uuid:44444444-4444-4444-8444-444444444444"],
          requiredStrength: "weak",
        },
      },
    };
    expect(TrustPolicySchema.safeParse(withExtension).success).toBe(true);
  });
});

describe("verifyPolicyChain", () => {
  test("(a) a valid 3-version chain verifies, resolving to the newest version", async () => {
    const genesisSealed = await sealTrustPolicy(GENESIS_TEMPLATE as TrustPolicy, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));
    const v2 = { ...V2_TEMPLATE, predecessor: genesisSealed.recordDigest } as TrustPolicy;
    const v2Sealed = await sealTrustPolicy(v2, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB", "did:key:z6MkKeyC"]));
    const v3 = { ...V3_TEMPLATE, predecessor: v2Sealed.recordDigest } as TrustPolicy;
    const v3Sealed = await sealTrustPolicy(v3, multiSigner(["did:key:z6MkKeyB", "did:key:z6MkKeyC"]));

    const result = verifyPolicyChain(
      [genesisSealed.envelopeBytes, v2Sealed.envelopeBytes, v3Sealed.envelopeBytes],
      {
        genesisAnchor: { digest: genesisSealed.recordDigest },
        now: NOW,
        dsseVerifier: trustingDsseVerifier,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.newest?.version).toBe(3);
  });

  test("(b) version N+1 missing the OLD signer-set threshold is rejected", async () => {
    const genesisSealed = await sealTrustPolicy(GENESIS_TEMPLATE as TrustPolicy, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));
    // Signed only by the NEW signer (C) -- genesis's old set {A,B} threshold 2 is not met at all.
    const badV2 = { ...V2_TEMPLATE, predecessor: genesisSealed.recordDigest } as TrustPolicy;
    const badV2Sealed = await sealTrustPolicy(badV2, multiSigner(["did:key:z6MkKeyC"]));

    const result = verifyPolicyChain(
      [genesisSealed.envelopeBytes, badV2Sealed.envelopeBytes],
      {
        genesisAnchor: { digest: genesisSealed.recordDigest },
        now: NOW,
        dsseVerifier: trustingDsseVerifier,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("dual-threshold-not-met");
  });

  test("(c) an expired refreshBy version (the resolved tip) is rejected", async () => {
    const expiredGenesis = { ...GENESIS_TEMPLATE, refreshBy: "2020-01-01T00:00:00Z" } as TrustPolicy;
    const sealed = await sealTrustPolicy(expiredGenesis, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));

    const result = verifyPolicyChain([sealed.envelopeBytes], {
      genesisAnchor: { digest: sealed.recordDigest },
      now: NOW,
      dsseVerifier: trustingDsseVerifier,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("policy-expired");
  });

  test("(d) a fork at an already-chained node (a competing successor version) is rejected as a rollback vector", async () => {
    const genesisSealed = await sealTrustPolicy(GENESIS_TEMPLATE as TrustPolicy, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));
    const v2 = { ...V2_TEMPLATE, predecessor: genesisSealed.recordDigest } as TrustPolicy;
    const v2Sealed = await sealTrustPolicy(v2, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB", "did:key:z6MkKeyC"]));
    // A second, distinct version also claiming to extend genesis directly --
    // structurally a fork/attempted-rollback at a point the chain already
    // moved past.
    const v2Fork = {
      ...V2_TEMPLATE,
      predecessor: genesisSealed.recordDigest,
      refreshBy: "2026-09-01T00:00:00Z",
    } as TrustPolicy;
    const v2ForkSealed = await sealTrustPolicy(v2Fork, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB", "did:key:z6MkKeyC"]));

    const result = verifyPolicyChain(
      [genesisSealed.envelopeBytes, v2Sealed.envelopeBytes, v2ForkSealed.envelopeBytes],
      {
        genesisAnchor: { digest: genesisSealed.recordDigest },
        now: NOW,
        dsseVerifier: trustingDsseVerifier,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("rollback-detected");
  });

  test("(e) competing genesis versions are surfaced as a policy conflict", async () => {
    const genesisA = await sealTrustPolicy(GENESIS_TEMPLATE as TrustPolicy, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));
    const genesisB = await sealTrustPolicy(
      { ...GENESIS_TEMPLATE, refreshBy: "2027-01-01T00:00:00Z" } as TrustPolicy,
      multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]),
    );

    const result = verifyPolicyChain([genesisA.envelopeBytes, genesisB.envelopeBytes], {
      genesisAnchor: { digest: genesisA.recordDigest },
      now: NOW,
      dsseVerifier: trustingDsseVerifier,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("competing-genesis");
  });

  test("(f) verifyPolicyChain is DSSE-offline + signer-set membership only -- it never recurses into binding resolution (§9)", async () => {
    const sealed = await sealTrustPolicy(GENESIS_TEMPLATE as TrustPolicy, multiSigner(["did:key:z6MkKeyA", "did:key:z6MkKeyB"]));

    // A trap: even if a caller mistakenly threaded a binding resolver
    // through the options object, verifyPolicyChain's implementation must
    // never call it -- it has no such parameter in its type, and this
    // proves it structurally never reaches for one at runtime either.
    const trapOptions = {
      genesisAnchor: { digest: sealed.recordDigest },
      now: NOW,
      dsseVerifier: trustingDsseVerifier,
      resolveBinding: () => {
        throw new Error("verifyPolicyChain must never call a binding resolver");
      },
    };

    const result = verifyPolicyChain([sealed.envelopeBytes], trapOptions);
    expect(result.ok).toBe(true);
  });
});

describe("sealTrustPolicy pinned-digest golden", () => {
  const golden = loadFixture("sealing-v1", "policy.json");

  const expectedDigestsPath = fileURLToPath(
    new URL("../fixtures/sealing-v1/expected-digests.json", import.meta.url),
  );
  const expectedDigests: Record<string, string> = JSON.parse(
    readFileSync(expectedDigestsPath, "utf8"),
  );

  test("sealTrustPolicy produces bytes whose recordDigest matches the pinned golden digest", async () => {
    const sealed = await sealTrustPolicy(golden as TrustPolicy, multiSigner(["did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz"]));
    const expected = expectedDigests["policy-golden"];
    if (expected === undefined) {
      throw new Error(
        `No pinned digest for "policy-golden" yet -- actual digest: ${sealed.recordDigest}\n`
          + "Paste this into fixtures/sealing-v1/expected-digests.json and re-run.",
      );
    }
    expect(sealed.recordDigest).toBe(expected);
  });
});
