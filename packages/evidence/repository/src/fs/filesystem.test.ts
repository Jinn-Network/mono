import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createArtifactReference,
  createRecordReference,
} from "../references.js";
import { describeEvidenceRepositoryContract } from "../testing.js";
import type { Sha256Digest } from "../types.js";
import {
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import {
  FILESYSTEM_REPOSITORY_FORMAT,
  createFilesystemEvidenceRepository,
} from "./index.js";

function digestPath(
  rootDir: string,
  digest: Sha256Digest,
): string {
  const hex = digest.slice("sha256:".length);
  return join(rootDir, "objects", "sha256", hex.slice(0, 2), hex.slice(2));
}

describeEvidenceRepositoryContract(async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-contract-"));
  return {
    repository: await createFilesystemEvidenceRepository({ rootDir }),
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
  };
});

describe("filesystem evidence repository", () => {
  test("preserves conforming golden records for consumer validation", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-golden-"));
    const fixtures = [
      {
        family: "execution-evidence",
        path: "../../../protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json",
        validate: validateExecutionEvidence,
      },
      {
        family: "result-evaluation",
        path: "../../../protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
        validate: validateResultEvaluation,
      },
      {
        family: "execution-verification",
        path: "../../../protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
        validate: validateExecutionVerification,
      },
    ] as const;

    try {
      const repository = await createFilesystemEvidenceRepository({ rootDir });
      for (const fixture of fixtures) {
        const bytes = new Uint8Array(
          await readFile(new URL(fixture.path, import.meta.url)),
        );
        const receipt = await repository.putRecord(fixture.family, bytes);
        const retrieved = await repository.getRecord(receipt.reference);

        expect(retrieved).toEqual(bytes);
        expect(fixture.validate(retrieved!).conforms).toBe(true);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("initializes a private, versioned native store", async () => {
    const parent = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-init-"));
    const rootDir = join(parent, "repository");

    try {
      await createFilesystemEvidenceRepository({ rootDir });

      expect(
        JSON.parse(await readFile(join(rootDir, "repository.json"), "utf8")),
      ).toEqual(FILESYSTEM_REPOSITORY_FORMAT);
      if (process.platform !== "win32") {
        expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
        expect(
          (await stat(join(rootDir, "repository.json"))).mode & 0o777,
        ).toBe(0o600);
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps concurrent identical writes valid and idempotent", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-race-"));
    try {
      const repositories = await Promise.all(
        Array.from({ length: 12 }, () =>
          createFilesystemEvidenceRepository({ rootDir }),
        ),
      );
      const bytes = new TextEncoder().encode("concurrent exact bytes");
      const receipts = await Promise.all(
        repositories.map((repository) =>
          repository.putRecord("execution-evidence", bytes),
        ),
      );

      expect(receipts.filter(({ status }) => status === "created")).toHaveLength(
        1,
      );
      expect(receipts.filter(({ status }) => status === "existing")).toHaveLength(
        11,
      );
      expect(
        await repositories[0]!.getRecord(receipts[0]!.reference),
      ).toEqual(bytes);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("reports object corruption instead of returning altered bytes", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-corrupt-"));
    try {
      const repository = await createFilesystemEvidenceRepository({ rootDir });
      const bytes = new TextEncoder().encode("original artifact");
      const receipt = await repository.putArtifact(bytes);
      await writeFile(
        digestPath(rootDir, receipt.reference.digest),
        new TextEncoder().encode("altered artifact"),
      );

      await expect(
        repository.getArtifact(receipt.reference),
      ).rejects.toMatchObject({ code: "CONTENT_CORRUPT" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("rejects incompatible repository versions", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-version-"));
    try {
      await writeFile(
        join(rootDir, "repository.json"),
        `${JSON.stringify({ ...FILESYSTEM_REPOSITORY_FORMAT, version: 2 })}\n`,
      );

      await expect(
        createFilesystemEvidenceRepository({ rootDir }),
      ).rejects.toMatchObject({ code: "IO_FAILURE" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform !== "win32")(
    "rejects symlinked roots and object paths",
    async () => {
      const parent = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-symlink-"));
      const target = join(parent, "target");
      const linkedRoot = join(parent, "linked");
      try {
        await mkdir(target);
        await symlink(target, linkedRoot);
        await expect(
          createFilesystemEvidenceRepository({ rootDir: linkedRoot }),
        ).rejects.toMatchObject({ code: "IO_FAILURE" });

        const repository = await createFilesystemEvidenceRepository({
          rootDir: target,
        });
        const bytes = new TextEncoder().encode("safe object");
        const reference = createArtifactReference(bytes);
        const objectPath = digestPath(target, reference.digest);
        await mkdir(dirname(objectPath), { recursive: true });
        const outside = join(parent, "outside");
        await writeFile(outside, bytes);
        await symlink(outside, objectPath);

        await expect(repository.getArtifact(reference)).rejects.toMatchObject({
          code: "CONTENT_CORRUPT",
        });
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  test("rejects conflicting record markers without changing content", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-marker-"));
    try {
      const repository = await createFilesystemEvidenceRepository({ rootDir });
      const bytes = new TextEncoder().encode("record marker");
      const reference = createRecordReference("result-evaluation", bytes);
      const hex = reference.digest.slice("sha256:".length);
      const markerPath = join(
        rootDir,
        "records",
        reference.family,
        "sha256",
        hex.slice(0, 2),
        `${hex.slice(2)}.json`,
      );
      await mkdir(dirname(markerPath), { recursive: true });
      await writeFile(
        markerPath,
        `${JSON.stringify({
          version: 1,
          family: "execution-evidence",
          digest: reference.digest,
        })}\n`,
      );

      await expect(
        repository.putRecord(reference.family, bytes),
      ).rejects.toMatchObject({ code: "REFERENCE_CONFLICT" });
      expect(
        new Uint8Array(
          await readFile(digestPath(rootDir, reference.digest)),
        ),
      ).toEqual(bytes);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("keeps the owned repository root private when reopened", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "jinn-evidence-fs-mode-"));
    try {
      const repository = await createFilesystemEvidenceRepository({ rootDir });
      const receipt = await repository.putArtifact(
        new TextEncoder().encode("private"),
      );
      if (process.platform !== "win32") {
        await createFilesystemEvidenceRepository({ rootDir });
        expect((await lstat(rootDir)).mode & 0o777).toBe(0o700);
        expect(
          (await lstat(digestPath(rootDir, receipt.reference.digest))).mode &
            0o777,
        ).toBe(0o600);
      }
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
