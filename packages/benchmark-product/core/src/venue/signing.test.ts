import { createPrivateKey, createPublicKey, verify as edVerify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalJsonBytes, dssePreAuthEncoding, parseDsseEnvelope } from "@jinn-network/trust-core";
import { BenchmarkProductError } from "../errors.js";
import {
  createVerdictDsseSigner,
  loadOrCreateVerdictSigningKey,
  readVerdictEnvelope,
  sealVerdictStatement,
} from "./signing.js";

const SPEC_DIGEST = "a".repeat(64);
const OTHER_SPEC_DIGEST = "b".repeat(64);

function statement(overrides: Partial<{ evaluatorId: string; specDigest: string; verdict: string }> = {}): Uint8Array {
  return canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: "subject-task.json", digest: { sha256: "c".repeat(64) } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluator: { id: overrides.evaluatorId ?? "urn:jinn:benchmark-product:local-venue:prediction-evaluator" },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: overrides.specDigest ?? SPEC_DIGEST },
      },
      taskSubject: "subject-task.json",
      resultSubjects: ["prediction"],
      verdict: overrides.verdict ?? "pass",
      measurements: [
        { name: "integrity", value: true },
        { name: "solverBrier", value: "0.010000" },
      ],
      evaluatedAt: "2026-08-05T00:00:00.000Z",
    },
  });
}

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp12-signing-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("loadOrCreateVerdictSigningKey", () => {
  it("generates a key on first use and persists PEM + sidecar", () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    expect(key.keyId).toMatch(/^benchmark-product-verdict-[0-9a-f]{16}$/);
    const pem = readFileSync(join(workspaceDir, "venue", "verdict-signing-key.pem"), "utf8");
    expect(pem).toContain("PRIVATE KEY");
    const sidecar = JSON.parse(readFileSync(join(workspaceDir, "venue", "verdict-signing-key.json"), "utf8"));
    expect(sidecar.keyId).toBe(key.keyId);
  });

  it("reuses the persisted key on a second call", () => {
    const first = loadOrCreateVerdictSigningKey(workspaceDir);
    const second = loadOrCreateVerdictSigningKey(workspaceDir);
    expect(second.keyId).toBe(first.keyId);
    const message = new TextEncoder().encode("probe");
    expect(second.sign(message)).toEqual(first.sign(message));
  });
});

describe("sealVerdictStatement + readVerdictEnvelope", () => {
  it("round-trips: seals a valid statement and reads it back with the same view", async () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    const statementBytes = statement();

    const envelopeBytes = await sealVerdictStatement({
      statementBytes,
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      expectedEvaluationSpecificationSha256: SPEC_DIGEST,
      signer,
    });

    const view = readVerdictEnvelope(envelopeBytes);
    expect(view).toEqual({
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      verdict: "pass",
      evaluationSpecificationSha256: SPEC_DIGEST,
      measurements: { integrity: true, solverBrier: "0.010000" },
      evaluatedAt: "2026-08-05T00:00:00.000Z",
    });
  });

  it("produces a signature that verifies against the workspace's own public key", async () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    const statementBytes = statement();
    const envelopeBytes = await sealVerdictStatement({
      statementBytes,
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      expectedEvaluationSpecificationSha256: SPEC_DIGEST,
      signer,
    });

    const parsedEnvelope = parseDsseEnvelope(envelopeBytes);
    const [signature] = parsedEnvelope.signatures;
    expect(signature?.keyid).toBe(key.keyId);

    // Re-derive the public key from the same private key material the signer used.
    const pem = readFileSync(join(workspaceDir, "venue", "verdict-signing-key.pem"), "utf8");
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const preAuthEncoding = dssePreAuthEncoding(parsedEnvelope.payloadType, parsedEnvelope.payloadBytes);
    const decoded = Uint8Array.from(atob(signature!.sig), (c) => c.charCodeAt(0));
    expect(edVerify(null, Buffer.from(preAuthEncoding), publicKey, Buffer.from(decoded))).toBe(true);
  });

  it("refuses a statement whose evaluator id does not match the venue", async () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    await expect(sealVerdictStatement({
      statementBytes: statement({ evaluatorId: "someone-else" }),
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      expectedEvaluationSpecificationSha256: SPEC_DIGEST,
      signer,
    })).rejects.toThrow(BenchmarkProductError);
  });

  it("refuses a statement whose EvaluationSpec digest does not match the cell", async () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    await expect(sealVerdictStatement({
      statementBytes: statement({ specDigest: OTHER_SPEC_DIGEST }),
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      expectedEvaluationSpecificationSha256: SPEC_DIGEST,
      signer,
    })).rejects.toThrow(BenchmarkProductError);
  });

  it("re-encodes a non-canonical (pretty-printed) statement to trust-core canonical bytes before sealing (BP-13 F1)", async () => {
    // The real evaluation harness writes pretty-printed, non-compact JSON (2-space indent,
    // trailing newline, `Object.keys().sort()` order) via `@jinn-network/attestation-issuer`'s
    // `deterministicJsonBytes` -- NOT `@jinn-network/trust-core`'s compact `canonicalJsonBytes`.
    // The aggregation boundary (`resolveVerdictOutcome`) requires the exact canonical encoding,
    // so sealVerdictStatement re-encodes the parsed statement and seals/signs THOSE bytes.
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    const rawStatement = {
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        verdict: "pass",
        evaluator: { id: "urn:jinn:benchmark-product:local-venue:prediction-evaluator" },
        evaluationSpecification: { digest: { sha256: SPEC_DIGEST } },
        evaluatedAt: "2026-08-05T00:00:00.000Z",
      },
    };
    const prettyPrinted = new TextEncoder().encode(`${JSON.stringify(rawStatement, null, 2)}\n`);
    const expectedCanonicalBytes = canonicalJsonBytes(rawStatement);

    const envelopeBytes = await sealVerdictStatement({
      statementBytes: prettyPrinted,
      evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
      expectedEvaluationSpecificationSha256: SPEC_DIGEST,
      signer,
    });
    const parsed = parseDsseEnvelope(envelopeBytes);
    expect(parsed.payloadBytes).toEqual(expectedCanonicalBytes);
    expect(parsed.payloadBytes).not.toEqual(prettyPrinted);

    // The signature covers the canonical PAE, not the harness's pretty-printed bytes.
    const pem = readFileSync(join(workspaceDir, "venue", "verdict-signing-key.pem"), "utf8");
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    const publicKey = createPublicKey(privateKey);
    const preAuthEncoding = dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes);
    const decoded = Uint8Array.from(atob(parsed.signatures[0]!.sig), (c) => c.charCodeAt(0));
    expect(edVerify(null, Buffer.from(preAuthEncoding), publicKey, Buffer.from(decoded))).toBe(true);

    // readVerdictEnvelope still reads the same semantic view despite the byte-level re-encoding.
    const view = readVerdictEnvelope(envelopeBytes);
    expect(view.verdict).toBe("pass");
    expect(view.evaluatorId).toBe("urn:jinn:benchmark-product:local-venue:prediction-evaluator");
  });

  it("refuses a statement carrying a non-safe-integer JSON number (§7.14) as a typed execution error", async () => {
    const key = loadOrCreateVerdictSigningKey(workspaceDir);
    const signer = createVerdictDsseSigner(key);
    // canonicalJsonBytes cannot be used to build this fixture (it would throw at fixture-build
    // time) -- plain JSON.stringify stands in for a hypothetical harness that wrote a fractional
    // measurement value as a JSON number rather than a decimal string.
    const statementBytes = new TextEncoder().encode(JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [{ name: "subject-task.json", digest: { sha256: "c".repeat(64) } }],
      predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
      predicate: {
        evaluator: { id: "urn:jinn:benchmark-product:local-venue:prediction-evaluator" },
        evaluationSpecification: { name: "evaluation-spec.json", digest: { sha256: SPEC_DIGEST } },
        taskSubject: "subject-task.json",
        resultSubjects: ["prediction"],
        verdict: "pass",
        measurements: [{ name: "nonIntegerScore", value: 0.123 }],
        evaluatedAt: "2026-08-05T00:00:00.000Z",
      },
    }));

    let thrown: unknown;
    try {
      await sealVerdictStatement({
        statementBytes,
        evaluatorId: "urn:jinn:benchmark-product:local-venue:prediction-evaluator",
        expectedEvaluationSpecificationSha256: SPEC_DIGEST,
        signer,
      });
    } catch (cause) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(BenchmarkProductError);
    expect((thrown as BenchmarkProductError).code).toBe("execution");
  });

  it("readVerdictEnvelope refuses a wrong payloadType", () => {
    const envelope = {
      payloadType: "application/json",
      payload: btoa("{}"),
      signatures: [{ sig: btoa("x") }],
    };
    expect(() => readVerdictEnvelope(new TextEncoder().encode(JSON.stringify(envelope))))
      .toThrow(BenchmarkProductError);
  });
});
