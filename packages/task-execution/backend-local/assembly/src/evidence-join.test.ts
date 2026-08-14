import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryEvidenceCatalog } from "@jinn-network/evidence-discovery";
import {
  EvidenceRepositoryError,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import type { HarvestResult, WorkspacePaths } from "@jinn-network/task-execution-workspace";
import { afterEach, describe, expect, test } from "vitest";
import {
  createEvidenceJoin,
  type EvidenceBindingPorts,
} from "./evidence-join.js";

const roots: string[] = [];

async function workspace(): Promise<WorkspacePaths> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "jinn-evidence-join-")));
  roots.push(root);
  const paths: WorkspacePaths = {
    root,
    input: join(root, "input"),
    work: join(root, "work"),
    out: join(root, "out"),
    logs: join(root, "logs"),
    harnessState: join(root, "harness-state"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
  await Promise.all(
    Object.values(paths)
      .filter((path) => path !== root)
      .map((path) => mkdir(path, { recursive: true })),
  );
  return paths;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function ports(
  repository: EvidenceRepository,
  onAwaitIndexed: () => void = () => {},
): EvidenceBindingPorts {
  return {
    repository,
    catalog: new InMemoryEvidenceCatalog(),
    async awaitIndexed(reference) {
      onAwaitIndexed();
      return { status: "not-announced", reference };
    },
  };
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("evidence recorder join (C3)", () => {
  test("captures exact Task + dispatch-context inputs and returns the finalization receipt", async () => {
    const paths = await workspace();
    const repository = new InMemoryEvidenceRepository();
    const taskBytes = new TextEncoder().encode('{"task":"exact sealed bytes"}');
    const dispatchContextBytes = new TextEncoder().encode(
      '{"attempt":"urn:uuid:10000000-0000-4000-8000-000000000001"}',
    );
    const launchPlanBytes = new TextEncoder().encode('{"argv":["fixture"]}');
    const outputBytes = new TextEncoder().encode("patch bytes\n");
    await writeFile(join(paths.out, "patch.diff"), outputBytes);

    const joiner = createEvidenceJoin({
      ports: ports(repository),
      source: "https://spec.jinn.network/software/backend-local",
      executor: "https://spec.jinn.network/software/fake-launcher",
      now: () => "2026-07-28T00:00:00.000Z",
    });
    const recording = await joiner.start({
      paths,
      attempt: "urn:uuid:10000000-0000-4000-8000-000000000001",
      taskDigest: sha256(taskBytes),
      taskBytes,
      dispatchContextBytes,
      launchPlanBytes,
      startedAt: "2026-07-28T00:00:00.000Z",
    });
    const harvest: HarvestResult = {
      manifest: [
        {
          path: "patch.diff",
          sizeBytes: outputBytes.byteLength,
          sha256: sha256(outputBytes),
          mediaType: "text/x-diff",
        },
      ],
      omissions: [],
      integrityViolations: [],
    };
    const receipt = await recording.finalize({
      harvest,
      outcome: "completed",
      endedAt: "2026-07-28T00:01:00.000Z",
    });

    expect(receipt.executionId).toMatch(/^urn:uuid:/);
    expect(receipt.record.family).toBe("execution-evidence");
    const recordBytes = await repository.getRecord(receipt.record);
    expect(recordBytes).not.toBeNull();
    const recordText = new TextDecoder().decode(recordBytes!);
    expect(recordText).toContain("input/task.sealed");
    expect(recordText).toContain("input/dispatch-context.json");
    expect(recordText).toContain("runtime/launch-plan.json");
    expect(recordText).toContain("results/patch.diff");
  });

  test("recorder finalization failure rejects and never fabricates a receipt", async () => {
    const paths = await workspace();
    const backing = new InMemoryEvidenceRepository();
    const repository: EvidenceRepository = {
      capabilities: backing.capabilities,
      putArtifact: backing.putArtifact.bind(backing),
      getArtifact: backing.getArtifact.bind(backing),
      getRecord: backing.getRecord.bind(backing),
      async putRecord() {
        throw new EvidenceRepositoryError("IO_FAILURE", "injected finalization failure");
      },
    };
    const bytes = new TextEncoder().encode("exact");
    const recording = await createEvidenceJoin({
      ports: ports(repository),
      source: "https://spec.jinn.network/software/backend-local",
      executor: "https://spec.jinn.network/software/fake-launcher",
    }).start({
      paths,
      attempt: "urn:uuid:10000000-0000-4000-8000-000000000002",
      taskDigest: sha256(bytes),
      taskBytes: bytes,
      dispatchContextBytes: bytes,
      launchPlanBytes: bytes,
      startedAt: "2026-07-28T00:00:00.000Z",
    });

    await expect(
      recording.finalize({
        harvest: { manifest: [], omissions: [], integrityViolations: [] },
        outcome: "completed",
        endedAt: "2026-07-28T00:01:00.000Z",
      }),
    ).rejects.toThrow("injected finalization failure");
  });

  test("finalization never waits for catalog indexing; awaitIndexed remains an explicit host port", async () => {
    const paths = await workspace();
    const repository = new InMemoryEvidenceRepository();
    let awaitCalls = 0;
    const joiner = createEvidenceJoin({
      ports: ports(repository, () => {
        awaitCalls += 1;
      }),
      source: "https://spec.jinn.network/software/backend-local",
      executor: "https://spec.jinn.network/software/fake-launcher",
    });
    const bytes = new TextEncoder().encode("exact");
    const recording = await joiner.start({
      paths,
      attempt: "urn:uuid:10000000-0000-4000-8000-000000000003",
      taskDigest: sha256(bytes),
      taskBytes: bytes,
      dispatchContextBytes: bytes,
      launchPlanBytes: bytes,
      startedAt: "2026-07-28T00:00:00.000Z",
    });
    const receipt = await recording.finalize({
      harvest: { manifest: [], omissions: [], integrityViolations: [] },
      outcome: "failed",
      endedAt: "2026-07-28T00:01:00.000Z",
    });

    expect(awaitCalls).toBe(0);
    await joiner.awaitIndexed(receipt.record);
    expect(awaitCalls).toBe(1);
  });

  /**
   * #36. `producer` defaults to `source`, so `source` and `executor` become two SEPARATE
   * `agent`-kind graph identities on every recording this join starts — with different
   * descriptor names ("Jinn backend-local" vs "Jinn executor launcher"). The recorder's
   * contextual-identity check therefore refuses one identity used for both roles. That refusal
   * is CORRECT and stays; what the composition must do is pass two distinct identities.
   */
  test("one identity used as both source and executor is refused; two distinct identities record cleanly (#36)", async () => {
    const bytes = new TextEncoder().encode("exact");
    // `createEvidenceJoin` types both identities as `${string}:${string}` (evidence-join.ts:54-55);
    // plain `string` is not assignable to it, so the helper must carry the same shape.
    const start = async (
      source: `${string}:${string}`,
      executor: `${string}:${string}`,
      attempt: `urn:uuid:${string}`,
    ) =>
      createEvidenceJoin({
        ports: ports(new InMemoryEvidenceRepository()),
        source,
        executor,
        now: () => "2026-07-28T00:00:00.000Z",
      }).start({
        paths: await workspace(),
        attempt,
        taskDigest: sha256(bytes),
        taskBytes: bytes,
        dispatchContextBytes: bytes,
        launchPlanBytes: bytes,
        startedAt: "2026-07-28T00:00:00.000Z",
      });

    const reused = "urn:uuid:44cfb891-0000-4000-8000-000000000001";
    await expect(start(reused, reused, "urn:uuid:10000000-0000-4000-8000-000000000004"))
      .rejects.toThrow(/reused for incompatible contextual roles/);

    await expect(start(
      reused,
      "urn:jinn:operator-runtime:0.2.2",
      "urn:uuid:10000000-0000-4000-8000-000000000005",
    )).resolves.toBeDefined();
  });

  test("the assembly source never imports the concrete evidence local runtime", async () => {
    const source = await readFile(new URL("./evidence-join.ts", import.meta.url), "utf8");
    expect(source).not.toContain("@jinn-network/evidence-local-runtime");
  });
});
