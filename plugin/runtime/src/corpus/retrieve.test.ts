// SPDX-License-Identifier: Apache-2.0
import { recordDigest } from "@jinn-network/evidence-protocol";
import type { EvidenceRepository } from "@jinn-network/evidence-repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  composeAdmission,
  createDeniedProducerAdmission,
  createFollowedSourceAdmission,
} from "./admission.js";
import { createCorpusRetrieval } from "./retrieve.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import type { CorpusFilesystem } from "./fs.js";
import { seedMirror, type SeededMirror } from "./testing-fixture.js";

const corpusFs = createNodeCorpusFilesystem();

const source = {
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
};

const ALICE = "https://agents.test/alice";

const admitAlice = composeAdmission(createFollowedSourceAdmission([source]), {
  admitSource: () => ({ status: "admitted" as const }),
  admitProducer: (id: string) =>
    id === ALICE
      ? ({ status: "admitted" } as const)
      : ({ status: "rejected", reason: "producer-not-listed" } as const),
});

let directory: string;
let paths: { catalogPath: string; objectsDirectory: string; fs: CorpusFilesystem };
let seeded: SeededMirror;

function retrieval(overrides: Partial<Parameters<typeof createCorpusRetrieval>[0]> = {}) {
  return createCorpusRetrieval({
    storePaths: paths,
    sources: [source],
    admission: admitAlice,
    ...overrides,
  });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "jinn-fetch-"));
  paths = {
    catalogPath: join(directory, "mirror", "catalog.sqlite"),
    objectsDirectory: join(directory, "mirror", "objects"),
    fs: corpusFs,
  };
  seeded = await seedMirror(paths, source);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("corpus retrieval", () => {
  test("returns the exact mirrored bytes for an admitted producer's record", async () => {
    const outcome = await retrieval().fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("fetched");
    if (outcome.status !== "fetched") throw new Error("unreachable");
    expect(recordDigest(outcome.result.canonicalBytes)).toBe(seeded.aliceReferences[0]!.digest);
    expect(outcome.result.validatedRecord.family).toBe("execution-evidence");
  });

  test("REFUSES a digest mismatch loudly, with the stack's own failure code", async () => {
    const tampering: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        return new TextEncoder().encode("tampered bytes");
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };

    const outcome = await retrieval({
      repositories: { async resolve() { return tampering; } },
    }).fetchRecord(seeded.aliceReferences[0]!);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("RECORD_DIGEST_MISMATCH");
    expect(outcome.failure.stage).toBe("record");
  });

  test("never surfaces mismatched bytes to the caller", async () => {
    const tampering: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        return new TextEncoder().encode("tampered bytes");
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };
    const outcome = await retrieval({
      repositories: { async resolve() { return tampering; } },
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(JSON.stringify(outcome)).not.toContain("tampered");
  });

  test("TRUST: refuses an unadmitted producer before touching any repository", async () => {
    let touched = false;
    const outcome = await retrieval({
      repositories: {
        async resolve() {
          touched = true;
          return null;
        },
      },
    }).fetchRecord(seeded.malloryReference);

    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("ACCEPTANCE_REJECTED");
    expect(outcome.failure.stage).toBe("acceptance");
    expect(touched).toBe(false);
  });

  test("TRUST: a fully denying admission refuses every record", async () => {
    const outcome = await retrieval({
      admission: composeAdmission(
        createFollowedSourceAdmission([source]),
        createDeniedProducerAdmission(),
      ),
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("failed");
  });

  test("reports a record that is not mirrored as NO_LOCATION rather than throwing", async () => {
    const outcome = await retrieval().fetchRecord({
      family: "execution-evidence",
      digest: `sha256:${"f".repeat(64)}`,
    });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.failure.code).toBe("NO_LOCATION");
  });

  test("prefers the local mirror over an upstream location", async () => {
    let upstreamReads = 0;
    const counting: EvidenceRepository = {
      capabilities: {},
      async getRecord() {
        upstreamReads += 1;
        return null;
      },
      async getArtifact() {
        return null;
      },
      async putRecord() {
        throw new Error("read-only");
      },
      async putArtifact() {
        throw new Error("read-only");
      },
    };
    const outcome = await retrieval({
      repositories: {
        async resolve(id: string) {
          return id === "jinn:corpus-mirror" ? seeded.localRepository : counting;
        },
      },
    }).fetchRecord(seeded.aliceReferences[0]!);
    expect(outcome.status).toBe("fetched");
    expect(upstreamReads).toBe(0);
  });

  test("propagates an abort as a failure value, not a throw", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await retrieval().fetchRecord(seeded.aliceReferences[0]!, {
      signal: controller.signal,
    });
    expect(outcome.status).toBe("failed");
  });
});
