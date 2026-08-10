import { verify as edVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DidKeySchema, dssePreAuthEncoding, parseDsseEnvelope, sealDsseEnvelope } from "@jinn-network/trust-core";
import {
  createReportDsseSigner,
  loadOrCreateReportSigningKey,
  verifyReportEnvelopeSignatures,
} from "./signing.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-signing-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Independent reimplementation (test-only) of base58btc decoding, to prove the module's own
 * encoder round-trips to the exact multicodec-prefixed public key bytes, not merely that it
 * matches trust-core's format regex. */
function decodeBase58btc(text: string): Uint8Array {
  let value = 0n;
  for (const character of text) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error(`invalid base58 character: ${character}`);
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  let leadingZeros = 0;
  for (const character of text) {
    if (character !== "1") break;
    leadingZeros += 1;
  }
  return new Uint8Array([...new Array(leadingZeros).fill(0), ...bytes]);
}

describe("loadOrCreateReportSigningKey", () => {
  it("generates a key on first use and persists PEM + sidecar, distinct from the verdict key's files", () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    expect(key.keyId).toMatch(/^did:key:z/);
    expect(DidKeySchema.safeParse(key.keyId).success).toBe(true);

    const pem = readFileSync(join(workspaceDir, "venue", "report-signing-key.pem"), "utf8");
    expect(pem).toContain("PRIVATE KEY");
    const sidecar = JSON.parse(readFileSync(join(workspaceDir, "venue", "report-signing-key.json"), "utf8"));
    expect(sidecar.keyId).toBe(key.keyId);

    // Distinct file basenames from the verdict-signing key (module header: role separation).
    expect(() => readFileSync(join(workspaceDir, "venue", "verdict-signing-key.pem"))).toThrow();
  });

  it("the keyId decodes (multicodec 0xed 0x01 + base58btc) to the exact raw Ed25519 public key bytes", () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const multibase = key.keyId.slice("did:key:z".length);
    const decoded = decodeBase58btc(multibase);
    expect(decoded.length).toBe(34);
    expect(decoded[0]).toBe(0xed);
    expect(decoded[1]).toBe(0x01);

    const jwk = key.publicKey.export({ format: "jwk" }) as { x?: string };
    const rawPublicKeyBytes = Buffer.from(jwk.x ?? "", "base64url");
    expect(Buffer.from(decoded.slice(2))).toEqual(rawPublicKeyBytes);
  });

  it("reuses the persisted key on a second call", () => {
    const first = loadOrCreateReportSigningKey(workspaceDir);
    const second = loadOrCreateReportSigningKey(workspaceDir);
    expect(second.keyId).toBe(first.keyId);
    const message = new TextEncoder().encode("probe");
    expect(second.sign(message)).toEqual(first.sign(message));
  });

  it("two different workspaces mint two different report keyIds", () => {
    const otherWorkspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-signing-other-"));
    try {
      const first = loadOrCreateReportSigningKey(workspaceDir);
      const second = loadOrCreateReportSigningKey(otherWorkspaceDir);
      expect(second.keyId).not.toBe(first.keyId);
    } finally {
      rmSync(otherWorkspaceDir, { recursive: true, force: true });
    }
  });
});

describe("createReportDsseSigner + verifyReportEnvelopeSignatures", () => {
  it("signs a DSSE envelope that verifies with plain node:crypto against the workspace's own public key", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const signer = createReportDsseSigner(key);
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ hello: "report" }));
    const payloadType = "application/vnd.jinn.benchmarking.report.v1+json";
    const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
    const signatures = await signer({ payloadType, payloadBytes, preAuthEncoding });
    expect(signatures).toHaveLength(1);
    expect(signatures[0]?.keyid).toBe(key.keyId);

    expect(edVerify(null, Buffer.from(preAuthEncoding), key.publicKey, Buffer.from(signatures[0]!.signature))).toBe(true);
  });

  it("verifyReportEnvelopeSignatures returns the report key's own keyid for a validly signed envelope", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const signer = createReportDsseSigner(key);
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ hello: "report" }));
    const payloadType = "application/vnd.jinn.benchmarking.report.v1+json";
    const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
    const signatures = await signer({ payloadType, payloadBytes, preAuthEncoding });
    const envelopeBytes = sealDsseEnvelope({ payloadBytes, signatures, payloadType });

    const outcome = verifyReportEnvelopeSignatures(envelopeBytes, key);
    expect(outcome.validSignerKeyids).toEqual([key.keyId]);
  });

  it("verifyReportEnvelopeSignatures returns no valid signers for an envelope signed by a foreign key", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const otherWorkspaceDir = mkdtempSync(join(tmpdir(), "bp13-report-signing-foreign-"));
    try {
      const foreignKey = loadOrCreateReportSigningKey(otherWorkspaceDir);
      const foreignSigner = createReportDsseSigner(foreignKey);
      const payloadBytes = new TextEncoder().encode(JSON.stringify({ hello: "report" }));
      const payloadType = "application/vnd.jinn.benchmarking.report.v1+json";
      const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
      const signatures = await foreignSigner({ payloadType, payloadBytes, preAuthEncoding });
      const envelopeBytes = sealDsseEnvelope({ payloadBytes, signatures, payloadType });

      const outcome = verifyReportEnvelopeSignatures(envelopeBytes, key);
      expect(outcome.validSignerKeyids).toEqual([]);
    } finally {
      rmSync(otherWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("verifyReportEnvelopeSignatures returns no valid signers when the payload was tampered after sealing", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const signer = createReportDsseSigner(key);
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ hello: "report" }));
    const payloadType = "application/vnd.jinn.benchmarking.report.v1+json";
    const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
    const signatures = await signer({ payloadType, payloadBytes, preAuthEncoding });
    const envelopeBytes = sealDsseEnvelope({ payloadBytes, signatures, payloadType });

    const tamperedPayload = new TextEncoder().encode(JSON.stringify({ hello: "tampered" }));
    const tamperedEnvelopeBytes = sealDsseEnvelope({ payloadBytes: tamperedPayload, signatures, payloadType });

    const outcome = verifyReportEnvelopeSignatures(tamperedEnvelopeBytes, key);
    expect(outcome.validSignerKeyids).toEqual([]);
  });

  it("verifyReportEnvelopeSignatures matches the DsseChainVerifier shape (single envelopeBytes arg, {validSignerKeyids})", async () => {
    const key = loadOrCreateReportSigningKey(workspaceDir);
    const signer = createReportDsseSigner(key);
    const payloadBytes = new TextEncoder().encode(JSON.stringify({ hello: "report" }));
    const payloadType = "application/vnd.jinn.benchmarking.report.v1+json";
    const preAuthEncoding = dssePreAuthEncoding(payloadType, payloadBytes);
    const signatures = await signer({ payloadType, payloadBytes, preAuthEncoding });
    const envelopeBytes = sealDsseEnvelope({ payloadBytes, signatures, payloadType });

    const dsseVerifier = (bytes: Uint8Array) => verifyReportEnvelopeSignatures(bytes, key);
    expect(dsseVerifier(envelopeBytes).validSignerKeyids).toEqual([key.keyId]);

    // parseDsseEnvelope sanity: payloadType round-trips.
    expect(parseDsseEnvelope(envelopeBytes).payloadType).toBe(payloadType);
  });
});
