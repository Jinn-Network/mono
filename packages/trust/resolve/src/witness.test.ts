// SPDX-License-Identifier: Apache-2.0

import { generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import {
  DSSE_PAYLOAD_TYPE,
  TRUST_KEY_BINDING_FORMAT,
  canonicalJsonBytes,
  ceremonyEvidenceDigest,
  didPkh,
  dssePreAuthEncoding,
  eip191MessageHash,
  parseExactDsseEnvelope,
  sealDsseEnvelope,
  sealSignedPayload,
  serializeCeremonyMessage,
  verifyEnvelopeBinding,
} from "@jinn-network/trust-core";
import type {
  DsseChainVerifier,
  KeyBinding,
  ResolvedBinding,
  SafeCeremonyEvidence,
  SiweCeremonyMessage,
} from "@jinn-network/trust-core";
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { ERC1271_IS_VALID_SIGNATURE_ABI, ERC1271_MAGIC_VALUE } from "./abis.js";
import { createWitnessVerifier } from "./witness.js";
import type { ArchiveReadClient } from "./witness.js";

const VERIFIER_IRI = "https://spec.jinn.network/agents/verifier-1";
const SAFE = "0x4444444444444444444444444444444444444444";
const HASH = `0x${"aa".repeat(32)}`;
const SIGNATURE = `0x${"bb".repeat(65)}`;
const BLOCK_HASH = `0x${"cc".repeat(32)}`;
const CHAIN_ID = 84532;

interface TestKey {
  readonly keyid: string;
  readonly publicKey: KeyObject;
  sign(bytes: Uint8Array): Uint8Array;
}

function ed25519Key(keyid: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { keyid, publicKey, sign: (bytes) => new Uint8Array(sign(null, bytes, privateKey)) };
}

/** The key that stands for VERIFIER_IRI, a key that stands for no one, and another accepted
 * verifier's key. */
const AUTHOR_KEY = ed25519Key("did:key:z6MkWitnessAuthor");
const STRANGER_KEY = ed25519Key("did:key:z6MkStranger");
const OTHER_VERIFIER_IRI = "https://spec.jinn.network/agents/verifier-2";
const OTHER_VERIFIER_KEY = ed25519Key("did:key:z6MkOtherVerifier");

/** trust-core's DSSE verifier port over the keys above: which of them signed the exact envelope's
 * pre-authentication encoding. What it cannot read, it throws on, as a port may. */
const dsseVerifier: DsseChainVerifier = (envelopeBytes) => {
  const envelope = parseExactDsseEnvelope(envelopeBytes);
  const preAuthEncoding = dssePreAuthEncoding(envelope.payloadType, envelope.payloadBytes);
  const keys = new Map([AUTHOR_KEY, STRANGER_KEY, OTHER_VERIFIER_KEY].map((key) => [key.keyid, key.publicKey]));
  return {
    validSignerKeyids: envelope.signatures.flatMap(({ keyid, sig }) => {
      const publicKey = keyid === undefined ? undefined : keys.get(keyid);
      return publicKey !== undefined && verify(null, preAuthEncoding, publicKey, Buffer.from(sig, "base64"))
        ? [keyid!]
        : [];
    }),
  };
};

/** A policy accepting VERIFIER_IRI and OTHER_VERIFIER_IRI, each spoken for by its own key. */
const ACCEPTING = {
  acceptedVerifiers: [VERIFIER_IRI, OTHER_VERIFIER_IRI],
  verifierKeys: new Map([[VERIFIER_IRI, [AUTHOR_KEY.keyid]], [OTHER_VERIFIER_IRI, [OTHER_VERIFIER_KEY.keyid]]]),
  dsseVerifier,
};

/** An archive client serving CHAIN_ID. */
function archive(readContract: ArchiveReadClient["readContract"]): ArchiveReadClient {
  return { getChainId: async () => CHAIN_ID, readContract };
}

function witnessPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chainId: CHAIN_ID,
    blockNumber: 12345,
    blockHash: BLOCK_HASH,
    verifier: VERIFIER_IRI,
    safe: SAFE,
    hash: HASH,
    signature: SIGNATURE,
    result: ERC1271_MAGIC_VALUE,
    ...overrides,
  };
}

/** A statement's bytes: its RFC 8785 form, or as written when it has none (a number no canonical
 * form holds), as a store could still hold it. */
function statementBytes(payload: Record<string, unknown>): Uint8Array {
  try {
    return canonicalJsonBytes(payload);
  } catch {
    return new TextEncoder().encode(JSON.stringify(payload));
  }
}

/** A statement under a signature that is no key's: enough for the archive, which believes no author. */
function sealWitnessPayload(payload: Record<string, unknown>): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes: statementBytes(payload),
    signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid: "did:key:zTestVerifierKey" }],
  });
}

/** `payloadBytes` sealed as a DSSE envelope that `key` signed. */
async function signedEnvelope(payloadBytes: Uint8Array, key: TestKey = AUTHOR_KEY): Promise<Uint8Array> {
  const { envelopeBytes } = await sealSignedPayload({
    payloadBytes,
    payloadType: DSSE_PAYLOAD_TYPE,
    signer: async ({ preAuthEncoding }) => [{ signature: key.sign(preAuthEncoding), keyid: key.keyid }],
  });
  return envelopeBytes;
}

/** A statement sealed in its RFC 8785 form and signed by `key`. */
function signWitnessPayload(payload: Record<string, unknown>, key: TestKey = AUTHOR_KEY): Promise<Uint8Array> {
  return signedEnvelope(canonicalJsonBytes(payload), key);
}

function outerWitness(payload: ReturnType<typeof witnessPayload>, envelopeBytes: Uint8Array) {
  return {
    chainId: payload.chainId,
    blockNumber: payload.blockNumber,
    blockHash: payload.blockHash,
    verifier: payload.verifier,
    envelopeBytes,
  };
}

describe("createWitnessVerifier", () => {
  it("verifies a witness statement a policy-accepted verifier's key signed", async () => {
    const payload = witnessPayload();
    const envelopeBytes = await signWitnessPayload(payload);
    const verifier = createWitnessVerifier(ACCEPTING);

    await expect(
      verifier.verify1271Witness(outerWitness(payload, envelopeBytes)),
    ).resolves.toEqual({ verified: true });
  });

  it("fails a fabricated (unsigned) witness envelope", async () => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });
    const fabricated = new TextEncoder().encode(
      JSON.stringify({ payloadType: "application/vnd.in-toto+json", payload: "not-base64!", signatures: [] }),
    );

    const result = await verifier.verify1271Witness({
      chainId: 84532,
      blockNumber: 12345,
      blockHash: BLOCK_HASH,
      verifier: VERIFIER_IRI,
      envelopeBytes: fabricated,
    });
    expect(result).toEqual({
      verified: false,
      reason: "witness envelope does not decode to a signed statement.",
    });
  });

  it.each([
    ["nothing", null],
    ["a number", 7],
    ["an empty object", {}],
    ["envelope bytes that are not bytes", { envelopeBytes: 7 }],
  ])("answers for a stored witness of %s, because a throw here reads as an outage", async (_label, witness) => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });
    await expect(verifier.verify1271Witness(witness as never)).resolves.toMatchObject({ verified: false });
  });

  it("fails when the witness statement content does not match the claimed fields (lifted witness)", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] });

    const result = await verifier.verify1271Witness({
      chainId: payload.chainId,
      blockNumber: payload.blockNumber,
      blockHash: `0x${"ff".repeat(32)}`, // mismatched blockHash
      verifier: payload.verifier,
      envelopeBytes,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/content does not match/);
  });

  it("falls back to archive re-execution when the witness author is not policy-accepted", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: archive(readContract),
    });

    await expect(
      verifier.verify1271Witness(outerWitness(payload, envelopeBytes)),
    ).resolves.toEqual({ verified: true });

    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: SAFE,
      functionName: "isValidSignature",
      args: [HASH, SIGNATURE],
      blockNumber: BigInt(payload.blockNumber),
    }));
  });

  it("fails closed when the witness author is not policy-accepted and no archive client is configured", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [] });

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not policy-accepted/);
  });

  it("fails the archive re-execution path when the on-chain result is not the magic value", async () => {
    const payload = witnessPayload();
    const envelopeBytes = sealWitnessPayload(payload);
    const readContract = vi.fn(async () => "0xdeadbeef");
    const verifier = createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: archive(readContract),
    });

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/magic value/);
  });

  describe("when the archive read does not return", () => {
    const payload = witnessPayload();
    const witness = outerWitness(payload, sealWitnessPayload(payload));
    const verifierFailingWith = (cause: unknown) => createWitnessVerifier({
      acceptedVerifiers: [],
      archiveClient: archive(async () => {
        throw cause;
      }),
    });
    /** A viem client's failure of the shape it wraps every contract read in, naming what went wrong. */
    const failedRead = (...causes: readonly string[]): Error => {
      const inner = causes.reduceRight<Error | undefined>(
        (cause, name) => Object.assign(new Error(name, cause === undefined ? {} : { cause }), { name }),
        undefined,
      );
      return new ContractFunctionExecutionError(inner as never, {
        abi: ERC1271_IS_VALID_SIGNATURE_ABI,
        args: [HASH, SIGNATURE],
        functionName: "isValidSignature",
      });
    };

    it.each([
      ["a client that says nothing of what failed", new Error("no route to host")],
      ["an unreachable node", failedRead("CallExecutionError", "HttpRequestError")],
      ["a node that timed out", failedRead("CallExecutionError", "TimeoutError")],
      ["a socket that failed", failedRead("CallExecutionError", "WebSocketRequestError")],
      ["a socket that closed", failedRead("CallExecutionError", "SocketClosedError")],
      ["a rate limit", failedRead("CallExecutionError", "LimitExceededRpcError")],
      ["an unreachable node, whatever wraps it", failedRead("ContractFunctionRevertedError", "HttpRequestError")],
    ])("lets %s out as an outage: no node took the read", async (_label, cause) => {
      await expect(verifierFailingWith(cause).verify1271Witness(witness)).rejects.toBe(cause);
    });

    it.each([
      ["reverted", new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: ERC1271_IS_VALID_SIGNATURE_ABI, functionName: "isValidSignature", message: "GS026" }),
        { abi: ERC1271_IS_VALID_SIGNATURE_ABI, args: [HASH, SIGNATURE], functionName: "isValidSignature" },
      )],
      ["reverted, however deep the client wrapped it", new Error("outer", {
        cause: new Error("middle", { cause: new Error("inner", { cause: failedRead("ContractFunctionRevertedError") }) }),
      })],
      ["has no code at that block", new ContractFunctionZeroDataError({ functionName: "isValidSignature" })],
      ["returned too few bytes", failedRead("AbiDecodingDataSizeTooSmallError")],
      ["ran out of gas", failedRead("CallExecutionError", "ExecutionRevertedError")],
      ["is at a block the node does not hold", failedRead("CallExecutionError", "InvalidInputRpcError")],
      ["is at a block the node holds no state for", failedRead("CallExecutionError", "ResourceUnavailableRpcError")],
    ])("takes a contract that %s as an answer: a statement chooses both, so it cannot read as an outage", async (_label, cause) => {
      const result = await verifierFailingWith(cause).verify1271Witness(witness);
      expect(result.verified).toBe(false);
      expect(result.reason).toMatch(/archive re-execution/);
    });
  });

  it.each([
    ["an address that is not one", { safe: "0xnot-an-address" }],
    ["an address whose checksum is wrong", { safe: "0x4444444444444444444444444444444444444AaA" }],
    ["a hash that is not 32 bytes", { hash: "0xaa" }],
    ["a hash of the right length that is not hex", { hash: `0x${"zz".repeat(32)}` }],
    ["a signature that is not hex", { signature: "bytes" }],
    ["a signature too large for a node to take", { signature: `0x${"bb".repeat(3_000_000)}` }],
    ["a block that is not a number on the chain", { blockNumber: 1.5 }],
    ["a block below the first", { blockNumber: -1 }],
    ["a block too far past what a number holds exactly", { blockNumber: 2 ** 53 }],
  ])("answers for a statement holding %s, before any read", async (_label, overrides) => {
    const payload = witnessPayload(overrides);
    const readContract = vi.fn(async () => {
      throw new Error("not read");
    });
    const verifier = createWitnessVerifier({ acceptedVerifiers: [], archiveClient: archive(readContract) });
    const result = await verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)));
    expect(result.verified).toBe(false);
    expect(readContract).not.toHaveBeenCalled();
  });

  it.each([
    ["the first block", { blockNumber: 0 }],
    ["an address in lower case", { safe: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" }],
    ["an empty signature", { signature: "0x" }],
    ["the largest signature it will put", { signature: `0x${"bb".repeat(1_048_576)}` }],
  ])("puts a statement naming %s to the archive", async (_label, overrides) => {
    const payload = witnessPayload(overrides);
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({ acceptedVerifiers: [], archiveClient: archive(readContract) });
    await expect(verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)))).resolves.toEqual({ verified: true });
    expect(readContract).toHaveBeenCalledOnce();
  });

  it("fails when the witness-attested result itself is not the magic value (even if policy-accepted)", async () => {
    const payload = witnessPayload({ result: "0xdeadbeef" });
    const envelopeBytes = await signWitnessPayload(payload);
    const verifier = createWitnessVerifier(ACCEPTING);

    const result = await verifier.verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/magic value/);
  });
});

// A statement naming a policy-accepted author is that author's word only when a key that stands
// for the author signed it. Anyone who can place a record can write the rest.
describe("a statement naming a policy-accepted author (§7.2a)", () => {
  const payload = witnessPayload();
  const otherHash = `0x${"dd".repeat(32)}`;

  it.each([
    ["a signature that does not verify", async () => sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(payload),
      signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid: AUTHOR_KEY.keyid }],
    })],
    ["a key that stands for no one", () => signWitnessPayload(payload, STRANGER_KEY)],
    ["the key of another accepted author", () => signWitnessPayload(payload, OTHER_VERIFIER_KEY)],
    ["its author's signature over another statement", async () => sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(payload),
      signatures: [{
        signature: AUTHOR_KEY.sign(dssePreAuthEncoding(DSSE_PAYLOAD_TYPE, canonicalJsonBytes(witnessPayload({ hash: otherHash })))),
        keyid: AUTHOR_KEY.keyid,
      }],
    })],
  ])("is refused under %s", async (_label, seal) => {
    const result = await createWitnessVerifier(ACCEPTING).verify1271Witness(outerWitness(payload, await seal()));
    expect(result).toEqual({
      verified: false,
      reason: `witness statement is not signed by a key that stands for its author "${VERIFIER_IRI}", and no `
        + "archive client is configured for re-execution.",
    });
  });

  it("is refused when no key is known to stand for its author", async () => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI], dsseVerifier });
    const result = await verifier.verify1271Witness(outerWitness(payload, await signWitnessPayload(payload)));
    expect(result.verified).toBe(false);
  });

  it("is refused when nothing can check its signature", async () => {
    const verifier = createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI], verifierKeys: ACCEPTING.verifierKeys });
    const result = await verifier.verify1271Witness(outerWitness(payload, await signWitnessPayload(payload)));
    expect(result.verified).toBe(false);
  });

  it("is refused, not thrown, when the signature check throws", async () => {
    const verifier = createWitnessVerifier({
      ...ACCEPTING,
      dsseVerifier: () => {
        throw new Error("unreadable");
      },
    });
    await expect(verifier.verify1271Witness(outerWitness(payload, await signWitnessPayload(payload))))
      .resolves.toMatchObject({ verified: false });
  });

  it("goes to the archive when its author's key did not sign it, and the chain's answer stands", async () => {
    const readContract = vi.fn(async () => "0xffffffff");
    const verifier = createWitnessVerifier({ ...ACCEPTING, archiveClient: archive(readContract) });
    const result = await verifier.verify1271Witness(outerWitness(payload, await signWitnessPayload(payload, STRANGER_KEY)));
    expect(result.verified).toBe(false);
    expect(readContract).toHaveBeenCalledOnce();
  });

  it("is refused when it repeats a member, though its author signed those bytes", async () => {
    const canonical = new TextDecoder().decode(canonicalJsonBytes(payload));
    const repeated = canonical.replace(`"hash":`, `"hash":"${otherHash}","hash":`);
    expect(repeated).not.toBe(canonical);
    const envelopeBytes = await signedEnvelope(new TextEncoder().encode(repeated));
    const result = await createWitnessVerifier(ACCEPTING).verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
  });

  it("is refused when it is not its RFC 8785 form, though its author signed those bytes", async () => {
    const envelopeBytes = await signedEnvelope(new TextEncoder().encode(JSON.stringify(payload)));
    const result = await createWitnessVerifier(ACCEPTING).verify1271Witness(outerWitness(payload, envelopeBytes));
    expect(result.verified).toBe(false);
  });

  it("is refused when its envelope carries a second payload beside the one its author signed", async () => {
    const signed = new TextDecoder().decode(await signWitnessPayload(witnessPayload({ hash: otherHash })));
    const claimed = Buffer.from(canonicalJsonBytes(payload)).toString("base64");
    const respelled = signed.replace(`","payloadType"`, `","payload":"${claimed}","payloadType"`);
    expect(respelled).not.toBe(signed);
    const result = await createWitnessVerifier(ACCEPTING)
      .verify1271Witness(outerWitness(payload, new TextEncoder().encode(respelled)));
    expect(result.verified).toBe(false);
  });
});

describe("a statement put to the archive", () => {
  const payload = witnessPayload();

  it("is refused, before any read, by a client serving another chain than the statement's", async () => {
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({
      archiveClient: { getChainId: async () => 8453, readContract },
    });
    const result = await verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)));
    expect(result).toEqual({
      verified: false,
      reason: `archive client serves chain 8453, not the statement's chain ${CHAIN_ID}.`,
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it("lets a client that cannot say which chain it serves out as an outage", async () => {
    const cause = new Error("no route to host");
    const readContract = vi.fn(async () => ERC1271_MAGIC_VALUE);
    const verifier = createWitnessVerifier({
      archiveClient: {
        getChainId: async () => {
          throw cause;
        },
        readContract,
      },
    });
    await expect(verifier.verify1271Witness(outerWitness(payload, sealWitnessPayload(payload)))).rejects.toBe(cause);
    expect(readContract).not.toHaveBeenCalled();
  });
});

// A host that wires this verifier into `verifyEnvelopeBinding` admits a Safe ceremony only when the
// message the witness's hash is of is that record's ceremony: under a verifier that accepts the
// witness, a genuine Safe signature over a message for another Agent IRI, key, domain or URI, or a
// witness over another message, binds nothing.
describe("a Safe ceremony checked with this verifier (§7.2, §7.2a)", () => {
  const AGENT = "https://spec.jinn.network/agents/safe-vouched";
  const KEY = "did:key:z6MkfSAFEWITNESSED111111111111111111111111";
  const SAFE_ADDRESS = "0x4444444444444444444444444444444444444444" as const;

  function siweMessage(overrides: Partial<SiweCeremonyMessage> = {}): SiweCeremonyMessage {
    return {
      domain: "trust.jinn.network",
      address: SAFE_ADDRESS,
      uri: "https://trust.jinn.network/ceremony/key-binding",
      version: "1",
      chainId: 84532,
      nonce: "n-safe-witnessed",
      issuedAt: "2026-01-01T00:00:00Z",
      resources: [AGENT, KEY],
      ...overrides,
    };
  }

  async function verifyWith(message: SiweCeremonyMessage, witnessed: Uint8Array = serializeCeremonyMessage("safe", message)) {
    const ceremonyEvidence: SafeCeremonyEvidence = {
      type: "safe",
      message,
      messageBytes: serializeCeremonyMessage("safe", message),
      signature: Uint8Array.of(0xbb),
    };
    const binding: KeyBinding = {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent: AGENT,
      key: { publicKey: KEY, keyid: KEY, algorithm: "ed25519", didKey: KEY },
      voucher: { kind: "account", did: didPkh(84532, SAFE_ADDRESS), contractAccount: true },
      relationship: "controls",
      scope: ["verdicts"],
      validFrom: "2026-01-01T00:00:00Z",
      ceremony: { type: "safe", digest: ceremonyEvidenceDigest(ceremonyEvidence) },
      strength: "strong",
      anchors: [],
    };
    const payload = witnessPayload({ safe: SAFE_ADDRESS, hash: eip191MessageHash(witnessed) });
    const resolved: ResolvedBinding = {
      binding,
      envelopeBytes: sealWitnessPayload({}),
      bindingDigest: `sha256:${"d".repeat(64)}`,
      effectiveStart: binding.validFrom,
      isGenesis: true,
      revocations: [],
      ceremonyEvidence,
      witness: outerWitness(payload, sealWitnessPayload(payload)),
    };
    return verifyEnvelopeBinding(
      { envelopeBytes: sealWitnessPayload({}), key: KEY, agent: AGENT, family: "verdicts", atTime: "2026-03-01T00:00:00Z" },
      {
        bindingResolver: { resolveBinding: async () => resolved },
        witnessVerifier: createWitnessVerifier({ acceptedVerifiers: [VERIFIER_IRI] }),
        dsseVerifier: () => ({ validSignerKeyids: [KEY] }),
      },
    );
  }

  it("admits a genuine ceremony whose witness this verifier accepts", async () => {
    await expect(verifyWith(siweMessage())).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["another Agent IRI", { resources: ["https://spec.jinn.network/agents/someone-else", KEY] }],
    ["another key", { resources: [AGENT, "did:key:z6MkfSOMEOTHERKEY11111111111111111111111111"] }],
    ["another domain", { domain: "login.example" }],
    ["another URI", { uri: "https://trust.jinn.network/login" }],
  ])("refuses a message naming %s, though the witness is accepted", async (_label, overrides) => {
    await expect(verifyWith(siweMessage(overrides))).resolves.toMatchObject({
      ok: false,
      reason: "ceremony-verification-failed",
    });
  });

  it("refuses a witness over another message", async () => {
    const other = serializeCeremonyMessage("safe", siweMessage({ nonce: "n-other" }));
    await expect(verifyWith(siweMessage(), other)).resolves.toMatchObject({
      ok: false,
      reason: "ceremony-verification-failed",
      detail: expect.stringMatching(/hash/),
    });
  });
});
