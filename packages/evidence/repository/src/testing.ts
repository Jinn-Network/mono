import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { assertRepositoryOperationActive } from "./errors.js";
import {
  createArtifactReference,
  createRecordReference,
  parseEvidenceArtifactReference,
  parseEvidenceRecordReference,
} from "./references.js";
import {
  EVIDENCE_RECORD_FAMILIES,
  type EvidenceArtifactReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "./types.js";

function cloneBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function recordKey(reference: EvidenceRecordReference): string {
  return `${reference.family}:${reference.digest}`;
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  readonly #records = new Map<string, Uint8Array>();
  readonly #artifacts = new Map<string, Uint8Array>();

  async putRecord(
    family: EvidenceRecordReference["family"],
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
    assertRepositoryOperationActive(options);
    const reference = createRecordReference(family, bytes);
    const key = recordKey(reference);
    const existing = this.#records.has(key);
    if (!existing) {
      this.#records.set(key, cloneBytes(bytes));
    }

    return {
      reference,
      size: bytes.byteLength,
      status: existing ? "existing" : "created",
    };
  }

  async getRecord(
    untrustedReference: EvidenceRecordReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceRecordReference(untrustedReference);
    const bytes = this.#records.get(recordKey(reference));
    return bytes === undefined ? null : cloneBytes(bytes);
  }

  async putArtifact(
    bytes: Uint8Array,
    options?: RepositoryOperationOptions,
  ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
    assertRepositoryOperationActive(options);
    const reference = createArtifactReference(bytes);
    const existing = this.#artifacts.has(reference.digest);
    if (!existing) {
      this.#artifacts.set(reference.digest, cloneBytes(bytes));
    }

    return {
      reference,
      size: bytes.byteLength,
      status: existing ? "existing" : "created",
    };
  }

  async getArtifact(
    untrustedReference: EvidenceArtifactReference,
    options?: RepositoryOperationOptions,
  ): Promise<Uint8Array | null> {
    assertRepositoryOperationActive(options);
    const reference = parseEvidenceArtifactReference(untrustedReference);
    const bytes = this.#artifacts.get(reference.digest);
    return bytes === undefined ? null : cloneBytes(bytes);
  }
}

export interface EvidenceRepositoryContractContext {
  readonly repository: EvidenceRepository;
  readonly cleanup?: () => Promise<void> | void;
}

export type EvidenceRepositoryContractFactory = (
  name: string,
) => Promise<EvidenceRepositoryContractContext> | EvidenceRepositoryContractContext;

export function describeEvidenceRepositoryContract(
  createContext: EvidenceRepositoryContractFactory,
): void {
  describe("EvidenceRepository contract", () => {
    let context: EvidenceRepositoryContractContext | undefined;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
    });

    afterEach(async () => {
      await context?.cleanup?.();
      context = undefined;
    });

    test.each(EVIDENCE_RECORD_FAMILIES)(
      "round-trips %s records byte-for-byte",
      async (family) => {
        const bytes = new TextEncoder().encode(`record:${family}`);
        const receipt = await context!.repository.putRecord(family, bytes);

        expect(receipt).toMatchObject({
          reference: createRecordReference(family, bytes),
          size: bytes.byteLength,
          status: "created",
        });
        expect(
          await context!.repository.getRecord(receipt.reference),
        ).toEqual(bytes);
      },
    );

    test("round-trips independent artifact bytes", async () => {
      const bytes = new Uint8Array([0, 1, 127, 128, 255]);
      const receipt = await context!.repository.putArtifact(bytes);

      expect(receipt).toMatchObject({
        reference: createArtifactReference(bytes),
        size: bytes.byteLength,
        status: "created",
      });
      expect(await context!.repository.getArtifact(receipt.reference)).toEqual(
        bytes,
      );
    });

    test("returns null for missing content", async () => {
      const recordBytes = new TextEncoder().encode("missing record");
      const artifactBytes = new TextEncoder().encode("missing artifact");

      expect(
        await context!.repository.getRecord(
          createRecordReference("execution-evidence", recordBytes),
        ),
      ).toBeNull();
      expect(
        await context!.repository.getArtifact(
          createArtifactReference(artifactBytes),
        ),
      ).toBeNull();
    });

    test("makes identical writes idempotent", async () => {
      const bytes = new TextEncoder().encode("same content");

      const firstRecord = await context!.repository.putRecord(
        "result-evaluation",
        bytes,
      );
      const secondRecord = await context!.repository.putRecord(
        "result-evaluation",
        bytes,
      );
      expect(firstRecord.status).toBe("created");
      expect(secondRecord).toEqual({ ...firstRecord, status: "existing" });

      const artifactBytes = new TextEncoder().encode("same artifact content");
      const firstArtifact = await context!.repository.putArtifact(artifactBytes);
      const secondArtifact = await context!.repository.putArtifact(artifactBytes);
      expect(firstArtifact.status).toBe("created");
      expect(secondArtifact).toEqual({
        ...firstArtifact,
        status: "existing",
      });
    });

    test("does not expose mutable stored buffers", async () => {
      const source = new Uint8Array([1, 2, 3]);
      const recordReceipt = await context!.repository.putRecord(
        "execution-verification",
        source,
      );
      const artifactReceipt = await context!.repository.putArtifact(source);
      source[0] = 99;

      const firstRecord = await context!.repository.getRecord(
        recordReceipt.reference,
      );
      const firstArtifact = await context!.repository.getArtifact(
        artifactReceipt.reference,
      );
      expect(firstRecord).toEqual(new Uint8Array([1, 2, 3]));
      expect(firstArtifact).toEqual(new Uint8Array([1, 2, 3]));

      firstRecord![1] = 98;
      firstArtifact![1] = 98;
      expect(
        await context!.repository.getRecord(recordReceipt.reference),
      ).toEqual(new Uint8Array([1, 2, 3]));
      expect(
        await context!.repository.getArtifact(artifactReceipt.reference),
      ).toEqual(new Uint8Array([1, 2, 3]));
    });

    test("honors an already-aborted signal", async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        context!.repository.putArtifact(new Uint8Array(), {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    });
  });
}
