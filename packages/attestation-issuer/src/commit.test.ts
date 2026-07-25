// SPDX-License-Identifier: Apache-2.0

import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test, vi } from "vitest";

import { commitPreparedAttestation } from "./commit.js";
import {
  prepareExecutionVerification,
  prepareResultEvaluation,
} from "./prepare.js";
import type { AnyPreparedAttestation, DsseSigner } from "./types.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const signer: DsseSigner = async () => [{ signature: new Uint8Array([1, 2, 3]) }];

async function prepared() {
  return await prepareResultEvaluation({
    task: { name: "task", digest },
    results: [{ name: "result", digest }],
    evaluator: { id: "https://example.test/evaluator" },
    evaluatedAt: "2026-07-24T12:00:00Z",
    verdict: "pass",
  }, signer);
}

describe("prepared repository commitment", () => {
  test("writes exact bytes idempotently without artifact operations", async () => {
    const repository = new InMemoryEvidenceRepository();
    const value = await prepared();
    const first = await commitPreparedAttestation(value, repository);
    const second = await commitPreparedAttestation(value, repository);
    expect(first).toMatchObject({
      family: value.family,
      recordDigest: value.recordDigest,
      repositoryReceipt: {
        reference: { family: value.family, digest: value.recordDigest },
        size: value.envelopeBytes.byteLength,
        status: "created",
      },
    });
    expect(second.repositoryReceipt.status).toBe("existing");
    expect(await repository.getRecord(first.repositoryReceipt.reference)).toEqual(
      value.envelopeBytes,
    );
  });

  test.each([
    (value: AnyPreparedAttestation) => ({ ...value, family: "execution-verification" }),
    (value: AnyPreparedAttestation) => ({ ...value, recordDigest: digest }),
    (value: AnyPreparedAttestation) => ({
      ...value,
      payloadBytes: new Uint8Array([0]),
    }),
    (value: AnyPreparedAttestation) => ({
      ...value,
      value: { ...value.value, statement: {} },
    }),
  ])("rejects inconsistent prepared structure before writing", async (mutate) => {
    const value = await prepared();
    const repository = new InMemoryEvidenceRepository();
    const put = vi.spyOn(repository, "putRecord");
    await expect(commitPreparedAttestation(
      mutate(value) as AnyPreparedAttestation,
      repository,
    )).rejects.toMatchObject({ code: "PREPARED_ATTESTATION_INVALID" });
    expect(put).not.toHaveBeenCalled();
  });

  test("does not trust methods attached to untrusted prepared byte arrays", async () => {
    const value = await prepared();
    const payloadBytes = new Uint8Array(value.payloadBytes.byteLength);
    Object.defineProperty(payloadBytes, "every", {
      value: () => true,
    });
    const repository = new InMemoryEvidenceRepository();
    const put = vi.spyOn(repository, "putRecord");
    await expect(commitPreparedAttestation({
      ...value,
      payloadBytes,
    }, repository)).rejects.toMatchObject({
      code: "PREPARED_ATTESTATION_INVALID",
    });
    expect(put).not.toHaveBeenCalled();
  });

  test("rejects contradictory repository receipts", async () => {
    const value = await prepared();
    const backing = new InMemoryEvidenceRepository();
    const repository: EvidenceRepository = {
      ...backing,
      putRecord: async () => ({
        reference: { family: "result-evaluation", digest: value.recordDigest },
        size: 0,
        status: "created",
      }),
      getRecord: backing.getRecord.bind(backing),
      putArtifact: backing.putArtifact.bind(backing),
      getArtifact: backing.getArtifact.bind(backing),
    };
    await expect(commitPreparedAttestation(value, repository)).rejects.toMatchObject({
      code: "INTERNAL_FAILURE",
    });
  });

  test("retries the same prepared bytes without resigning", async () => {
    const signingSpy = vi.fn(signer);
    const value = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, signingSpy);
    const backing = new InMemoryEvidenceRepository();
    const injected = new EvidenceRepositoryError("IO_FAILURE", "injected");
    let first = true;
    const repository: EvidenceRepository = {
      putRecord: async (...args) => {
        if (first) {
          first = false;
          throw injected;
        }
        return await backing.putRecord(...args);
      },
      getRecord: backing.getRecord.bind(backing),
      putArtifact: backing.putArtifact.bind(backing),
      getArtifact: backing.getArtifact.bind(backing),
    };
    await expect(commitPreparedAttestation(value, repository)).rejects.toBe(injected);
    const receipt = await commitPreparedAttestation(value, repository);
    expect(receipt.recordDigest).toBe(value.recordDigest);
    expect(signingSpy).toHaveBeenCalledTimes(1);
  });

  test("honors cancellation before repository access", async () => {
    const value = await prepared();
    const repository = new InMemoryEvidenceRepository();
    const put = vi.spyOn(repository, "putRecord");
    const controller = new AbortController();
    controller.abort();
    await expect(commitPreparedAttestation(value, repository, {
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    expect(put).not.toHaveBeenCalled();
  });

  test("commitment invokes only putRecord and never signs", async () => {
    const signingSpy = vi.fn(signer);
    const value = await prepareResultEvaluation({
      task: { name: "task", digest },
      results: [{ name: "result", digest }],
      evaluator: { id: "https://example.test/evaluator" },
      evaluatedAt: "2026-07-24T12:00:00Z",
      verdict: "pass",
    }, signingSpy);
    const repository = new InMemoryEvidenceRepository();
    const getRecord = vi.spyOn(repository, "getRecord");
    const putArtifact = vi.spyOn(repository, "putArtifact");
    const getArtifact = vi.spyOn(repository, "getArtifact");
    await commitPreparedAttestation(value, repository);
    expect(signingSpy).toHaveBeenCalledTimes(1);
    expect(getRecord).not.toHaveBeenCalled();
    expect(putArtifact).not.toHaveBeenCalled();
    expect(getArtifact).not.toHaveBeenCalled();
  });

  test("rejects another family's parsed value", async () => {
    const value = await prepared();
    const other = await prepareExecutionVerification({
      executionEvidenceDigest: digest,
      executionId: "urn:uuid:11111111-1111-4111-8111-111111111111",
      verifier: { id: "https://example.test/verifier" },
      verifiedAt: "2026-07-24T12:00:00Z",
      verdict: "verified",
    }, signer);
    const repository = new InMemoryEvidenceRepository();
    const put = vi.spyOn(repository, "putRecord");
    await expect(commitPreparedAttestation({
      ...value,
      value: other.value,
    } as unknown as AnyPreparedAttestation, repository)).rejects.toMatchObject({
      code: "PREPARED_ATTESTATION_INVALID",
    });
    expect(put).not.toHaveBeenCalled();
  });

  test.each(["mutated-byte", "missing-signature", "extra-signature"] as const)(
    "rejects %s envelope changes before writing",
    async (kind) => {
      const value = await prepared();
      let envelopeBytes = Uint8Array.from(value.envelopeBytes);
      if (kind === "mutated-byte") {
        envelopeBytes[0] = 0;
      } else {
        const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes));
        envelope.signatures = kind === "missing-signature"
          ? []
          : [...envelope.signatures, { sig: "AQ==" }];
        envelopeBytes = new TextEncoder().encode(JSON.stringify(envelope));
      }
      const repository = new InMemoryEvidenceRepository();
      const put = vi.spyOn(repository, "putRecord");
      await expect(commitPreparedAttestation({
        ...value,
        envelopeBytes,
      }, repository)).rejects.toMatchObject({
        code: "PREPARED_ATTESTATION_INVALID",
      });
      expect(put).not.toHaveBeenCalled();
    },
  );

  test.each([
    { reference: { family: "execution-verification" }, field: "family" },
    { reference: { digest }, field: "digest" },
    { size: 0, field: "size" },
    { status: "impossible", field: "status" },
  ])("rejects contradictory repository receipt $field", async (change) => {
    const value = await prepared();
    const repository = new InMemoryEvidenceRepository();
    const contract: EvidenceRepository = {
      putRecord: async () => ({
        reference: {
          family: (change.reference?.family ?? value.family) as never,
          digest: (change.reference?.digest ?? value.recordDigest) as never,
        },
        size: change.size ?? value.envelopeBytes.byteLength,
        status: (change.status ?? "created") as never,
      }),
      getRecord: repository.getRecord.bind(repository),
      putArtifact: repository.putArtifact.bind(repository),
      getArtifact: repository.getArtifact.bind(repository),
    };
    await expect(commitPreparedAttestation(value, contract)).rejects.toMatchObject({
      code: "INTERNAL_FAILURE",
    });
  });

  test("snapshots untrusted receipt primitives once and strips extra fields", async () => {
    const value = await prepared();
    const repository = new InMemoryEvidenceRepository();
    let familyReads = 0;
    let digestReads = 0;
    let sizeReads = 0;
    let statusReads = 0;
    const reference = {
      get family() {
        familyReads += 1;
        return familyReads === 1 ? value.family : "execution-verification";
      },
      get digest() {
        digestReads += 1;
        return digestReads === 1 ? value.recordDigest : digest;
      },
      trust: "must-not-leak",
    };
    const contract: EvidenceRepository = {
      putRecord: async () => ({
        reference,
        get size() {
          sizeReads += 1;
          return sizeReads === 1 ? value.envelopeBytes.byteLength : 0;
        },
        get status() {
          statusReads += 1;
          return statusReads === 1 ? "created" : "impossible";
        },
      } as never),
      getRecord: repository.getRecord.bind(repository),
      putArtifact: repository.putArtifact.bind(repository),
      getArtifact: repository.getArtifact.bind(repository),
    };
    const receipt = await commitPreparedAttestation(value, contract);
    expect(receipt.repositoryReceipt).toEqual({
      reference: {
        family: value.family,
        digest: value.recordDigest,
      },
      size: value.envelopeBytes.byteLength,
      status: "created",
    });
    expect({ familyReads, digestReads, sizeReads, statusReads }).toEqual({
      familyReads: 1,
      digestReads: 1,
      sizeReads: 1,
      statusReads: 1,
    });
    expect(receipt.repositoryReceipt.reference).not.toHaveProperty("trust");
  });

  test("maps malformed or throwing receipts to INTERNAL_FAILURE", async () => {
    const value = await prepared();
    const repository = new InMemoryEvidenceRepository();
    for (const receipt of [
      null,
      Object.defineProperty({}, "reference", {
        get: () => {
          throw new Error("hostile getter");
        },
      }),
    ]) {
      const contract: EvidenceRepository = {
        putRecord: async () => receipt as never,
        getRecord: repository.getRecord.bind(repository),
        putArtifact: repository.putArtifact.bind(repository),
        getArtifact: repository.getArtifact.bind(repository),
      };
      await expect(commitPreparedAttestation(value, contract)).rejects.toMatchObject({
        code: "INTERNAL_FAILURE",
      });
    }
  });

  test("rejects prepared accessors with stable identity before repository access", async () => {
    const value = await prepared();
    const hostile = Object.defineProperty(
      { ...value },
      "envelopeBytes",
      {
        enumerable: true,
        get() {
          throw new Error("hostile prepared getter");
        },
      },
    );
    const repository = new InMemoryEvidenceRepository();
    const put = vi.spyOn(repository, "putRecord");
    await expect(
      commitPreparedAttestation(hostile as never, repository),
    ).rejects.toMatchObject({ code: "PREPARED_ATTESTATION_INVALID" });
    expect(put).not.toHaveBeenCalled();
  });
});
