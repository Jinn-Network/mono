// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ceremonyEvidenceDigest,
  deriveStrength,
  sealKeyBinding,
  serializeCeremonyMessage,
  sealSignedRecord,
} from "@jinn-network/trust-core";
import type { CeremonyType, EoaCeremonyEvidence, KeyBinding, SiweCeremonyMessage } from "@jinn-network/trust-core";
import { createEoaTestSigner } from "@jinn-network/trust-testing";

import { checkRecord, createStaticBindingResolver, didKeyFromEd25519PublicKey, recordDigest } from "./index.js";
import type { RecordReport } from "./index.js";

const AGENT = "urn:uuid:11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "urn:uuid:22222222-2222-4222-8222-222222222222";
const VOUCHER_SIGNER = createEoaTestSigner("static-binding-resolver");
const VOUCHER = {
  kind: "account",
  did: `did:pkh:eip155:8453:${VOUCHER_SIGNER.address}`,
  contractAccount: false,
} as const;

interface Key {
  readonly publicKey: KeyObject;
  readonly privateKey: KeyObject;
  readonly keyid: string;
}

function ed25519(): Key {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey, privateKey, keyid: didKeyFromEd25519PublicKey(publicKey) };
}

function signerFor(key: Key) {
  return async ({ preAuthEncoding }: { readonly preAuthEncoding: Uint8Array }) =>
    [{ keyid: key.keyid, signature: new Uint8Array(sign(null, preAuthEncoding, key.privateKey)) }] as const;
}

function eoaEvidence(agent: string, key: Key): EoaCeremonyEvidence {
  const message: SiweCeremonyMessage = {
    domain: "trust.jinn.network",
    address: VOUCHER_SIGNER.address,
    uri: "https://trust.jinn.network/ceremony/key-binding",
    version: "1",
    chainId: 8453,
    nonce: "static-binding-resolver",
    issuedAt: "2026-01-01T00:00:00.000Z",
    resources: [agent, key.keyid],
  };
  const messageBytes = serializeCeremonyMessage("eoa", message);
  return { type: "eoa", message, messageBytes, signature: VOUCHER_SIGNER.sign(messageBytes) };
}

async function sealedBinding(key: Key, options: {
  readonly agent?: string;
  readonly signer?: Key;
  readonly ceremonyType?: CeremonyType;
  readonly validFrom?: string;
  readonly expiresAt?: string;
  readonly scope?: readonly string[];
} = {}) {
  const agent = options.agent ?? AGENT;
  const ceremonyType = options.ceremonyType ?? "eoa";
  const ceremonyEvidence = eoaEvidence(agent, key);
  const binding: KeyBinding = {
    protocol: "https://spec.jinn.network/trust/key-binding/v1",
    agent,
    key: { publicKey: key.keyid, keyid: key.keyid, algorithm: "ed25519", didKey: key.keyid },
    voucher: VOUCHER,
    relationship: "controls",
    scope: [...(options.scope ?? ["verdicts"])],
    validFrom: options.validFrom ?? "2026-01-01T00:00:00Z",
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    ceremony: { type: ceremonyType, digest: ceremonyEvidenceDigest(ceremonyEvidence) },
    strength: deriveStrength(ceremonyType),
    anchors: [],
  };
  const { envelopeBytes } = await sealKeyBinding(binding, signerFor(options.signer ?? key));
  return { binding, envelopeBytes, ceremonyEvidence };
}

async function signedEvaluation(key: Key, evaluator = AGENT, evaluatedAt = "2026-07-28T00:10:00Z"): Promise<Uint8Array> {
  const { envelopeBytes } = await sealSignedRecord({
    record: {
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        { name: "task", digest: { sha256: "4".repeat(64) } },
        { name: "result", digest: { sha256: "5".repeat(64) } },
      ],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluatedAt,
        evaluator: { id: evaluator },
        verdict: "pass",
        taskSubject: "task",
        resultSubjects: ["result"],
      },
    },
    payloadType: "application/vnd.in-toto+json",
    signer: signerFor(key),
  });
  return envelopeBytes;
}

function binding(report: RecordReport) {
  return report.checks.find(({ id }) => id === "trust-binding")!;
}

describe("createStaticBindingResolver", () => {
  test("resolves the pair a held key binding states", async () => {
    const key = ed25519();
    const { envelopeBytes, ceremonyEvidence } = await sealedBinding(key);
    const resolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    const resolved = await resolver.resolveBinding({ key: key.keyid, agent: AGENT }, "2026-07-28T00:00:00Z");
    expect(resolved).toMatchObject({
      bindingDigest: recordDigest(envelopeBytes),
      effectiveStart: "2026-01-01T00:00:00Z",
      isGenesis: true,
      revocations: [],
    });
    expect(resolved?.ceremonyEvidence).toBe(ceremonyEvidence);
    expect(await resolver.resolveBinding({ key: key.keyid, agent: OTHER_AGENT }, "2026-07-28T00:00:00Z")).toBeNull();
    expect(await resolver.resolveBinding({ key: ed25519().keyid, agent: AGENT }, "2026-07-28T00:00:00Z")).toBeNull();
  });

  test("a record signed by a did:key passes trust binding through a binding outside any bundle", async () => {
    const key = ed25519();
    const { envelopeBytes, ceremonyEvidence } = await sealedBinding(key);
    const bindingResolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    const report = await checkRecord(await signedEvaluation(key), { trust: { bindingResolver } });
    expect(report.checks.map(({ status }) => status)).toEqual(["skipped", "skipped", "passed", "passed", "passed"]);
    expect(report.outcome).toBe("checked");
  });

  test("the binding record itself stands on its ceremony, through the same procedure", async () => {
    const key = ed25519();
    const { envelopeBytes, ceremonyEvidence } = await sealedBinding(key);
    const bindingResolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    expect(binding(await checkRecord(envelopeBytes, { trust: { bindingResolver } })).status).toBe("passed");
  });

  test("a binding accepted on its envelope signature alone is refused: no ceremony evidence, no binding", async () => {
    const key = ed25519();
    const { envelopeBytes } = await sealedBinding(key);
    const bindingResolver = createStaticBindingResolver([envelopeBytes]);
    const report = await checkRecord(await signedEvaluation(key), { trust: { bindingResolver } });
    expect(binding(report).status).toBe("failed");
    expect(binding(report).findings[0]).toMatchObject({ code: "ceremony-verification-failed" });
  });

  test("ceremony evidence that is not what the binding committed to is refused", async () => {
    const key = ed25519();
    const { envelopeBytes } = await sealedBinding(key);
    const ceremonyEvidence = eoaEvidence(OTHER_AGENT, key);
    const bindingResolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    const report = await checkRecord(await signedEvaluation(key), { trust: { bindingResolver } });
    expect(binding(report).findings[0]).toMatchObject({ code: "ceremony-verification-failed" });
  });

  test.each(["agentId", "oidc-machine", "github-human"] as const)(
    "a %s binding does not resolve: trust-core leaves that ceremony to the resolver, and this one cannot run it",
    async (ceremonyType) => {
      const key = ed25519();
      const { envelopeBytes } = await sealedBinding(key, { ceremonyType });
      const bindingResolver = createStaticBindingResolver([envelopeBytes]);
      expect(await bindingResolver.resolveBinding({ key: key.keyid, agent: AGENT }, "2026-07-28T00:00:00Z")).toBeNull();
      const report = await checkRecord(await signedEvaluation(key), { trust: { bindingResolver } });
      expect(binding(report).findings[0]).toMatchObject({ code: "binding-not-resolved" });
    },
  );

  test("a binding its own key did not sign does not resolve", async () => {
    const victim = ed25519();
    const attacker = ed25519();
    const { envelopeBytes, ceremonyEvidence } = await sealedBinding(victim, { signer: attacker });
    const resolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    expect(await resolver.resolveBinding({ key: victim.keyid, agent: AGENT }, "2026-07-28T00:00:00Z")).toBeNull();
  });

  test("bytes that are not a key binding are ignored", async () => {
    const resolver = createStaticBindingResolver([new TextEncoder().encode("{}"), Uint8Array.of(0xff)]);
    expect(await resolver.resolveBinding({ key: ed25519().keyid, agent: AGENT }, "2026-07-28T00:00:00Z")).toBeNull();
  });

  test("a binding resolves only inside its validity window", async () => {
    const key = ed25519();
    const { envelopeBytes, ceremonyEvidence } = await sealedBinding(key, {
      validFrom: "2026-02-01T00:00:00Z",
      expiresAt: "2026-03-01T00:00:00Z",
    });
    const resolver = createStaticBindingResolver([{ envelopeBytes, ceremonyEvidence }]);
    const query = { key: key.keyid, agent: AGENT };
    expect(await resolver.resolveBinding(query, "2026-01-31T23:59:59Z")).toBeNull();
    expect(await resolver.resolveBinding(query, "2026-02-15T00:00:00Z")).not.toBeNull();
    expect(await resolver.resolveBinding(query, "2026-03-01T00:00:01Z")).toBeNull();
  });

  test("a later binding for the same agent is not genesis and names the voucher already in control", async () => {
    const first = ed25519();
    const second = ed25519();
    const earlier = await sealedBinding(first, { validFrom: "2026-01-01T00:00:00Z" });
    const later = await sealedBinding(second, { validFrom: "2026-02-01T00:00:00Z" });
    const resolver = createStaticBindingResolver([later, earlier].map(({ envelopeBytes, ceremonyEvidence }) => ({ envelopeBytes, ceremonyEvidence })));
    const atTime = "2026-07-28T00:00:00Z";
    expect(await resolver.resolveBinding({ key: first.keyid, agent: AGENT }, atTime)).toMatchObject({ isGenesis: true });
    const resolved = await resolver.resolveBinding({ key: second.keyid, agent: AGENT }, atTime);
    expect(resolved).toMatchObject({ isGenesis: false, incumbentControlVoucher: VOUCHER });
    const report = await checkRecord(await signedEvaluation(second), {
      trust: { bindingResolver: resolver },
    });
    expect(binding(report).status).toBe("passed");
  });

  test("two bindings of one key to one agent resolve to the earlier", async () => {
    const key = ed25519();
    const earlier = await sealedBinding(key, { validFrom: "2026-01-01T00:00:00Z" });
    const later = await sealedBinding(key, { validFrom: "2026-02-01T00:00:00Z" });
    const resolver = createStaticBindingResolver([later, earlier].map(({ envelopeBytes, ceremonyEvidence }) => ({ envelopeBytes, ceremonyEvidence })));
    const resolved = await resolver.resolveBinding({ key: key.keyid, agent: AGENT }, "2026-07-28T00:00:00Z");
    expect(resolved?.bindingDigest).toBe(recordDigest(earlier.envelopeBytes));
  });
});
