// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { VerifyDriver, VerifySourceOptions } from "@jinn-network/record-discovery-client";
import type { SourceChainOutcome } from "@jinn-network/record-discovery-protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { resolveRuntimeConfig } from "../config.js";
import { createCorpusCapability } from "./capability.js";
import { createFileHighWaterMarkStore } from "./high-water-mark.js";
import { createNodeCorpusFilesystem } from "./node-fs.test.js";
import { buildFixtureArchive, fixtureTrustDsseVerifier, seedMirror } from "./testing-fixture.js";

const corpusFs = createNodeCorpusFilesystem();

let home: string;

const source = () => ({
  agent: "https://agents.test/alice",
  name: "attempts",
  servingRoot: "https://archive.test",
  archiveRootUrl: "https://archive.test/sources/attempts/entries/0000000000000001",
  repositoryId: "archive.test/attempts",
});

const transport = {
  async fetch() {
    return { status: 503, bytes: new Uint8Array() };
  },
};

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function context(file?: unknown) {
  return {
    config: resolveRuntimeConfig({ env: {}, homeDirectory: home, ...(file === undefined ? {} : { file }) }),
    log: log(),
  };
}

function capability(file?: unknown, verifyDriver?: VerifyDriver) {
  const built = createCorpusCapability({
    transport,
    fs: corpusFs,
    dsseVerifier: () => ({ validSignerKeyids: [] }),
    readPolicyVersions: async () => [],
    ...(verifyDriver === undefined ? {} : { verifyDriver }),
  });
  return { capability: built, context: context(file) };
}

/**
 * A `VerifyDriver` whose source-chain verdict the test picks. Only
 * `verifySource` is reachable from the corpus mirror; the two item-level
 * methods belong to the read path C6 owns and are never called here.
 */
function driverReturning(outcome: SourceChainOutcome): VerifyDriver & { readonly calls: VerifySourceOptions[] } {
  const calls: VerifySourceOptions[] = [];
  return {
    calls,
    async verifySource(opts: VerifySourceOptions): Promise<SourceChainOutcome> {
      // Drain the entry stream the way the real driver does, so a posture
      // that never reaches the driver is distinguishable from one that does.
      for await (const _entry of opts.entries) void _entry;
      calls.push(opts);
      return outcome;
    },
    async verifyForDecision() {
      throw new Error("the corpus mirror never verifies items");
    },
    async verifyForFilter() {
      throw new Error("the corpus mirror never verifies items");
    },
  };
}

/** A capability wired to a real fixture archive, so `syncOnce` reaches the posture. */
function overArchive(options: {
  readonly file: Record<string, unknown>;
  readonly verifyDriver?: VerifyDriver;
  readonly signHead?: boolean;
}) {
  const archive = buildFixtureArchive(source(), ["https://agents.test/alice"], {
    signHead: options.signHead ?? true,
  });
  const built = createCorpusCapability({
    transport: archive.transport,
    fs: corpusFs,
    dsseVerifier: fixtureTrustDsseVerifier,
    readPolicyVersions: async () => archive.policyVersions,
    now: () => new Date("2026-07-30T00:00:00Z"),
    ...(options.verifyDriver === undefined ? {} : { verifyDriver: options.verifyDriver }),
  });
  return {
    capability: built,
    context: context({
      corpus: {
        sources: [source()],
        ...options.file,
        trust: { genesisDigest: archive.genesisDigest, policyDirectory: "policy" },
      },
    }),
  };
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "jinn-cap-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("corpus capability", () => {
  test("is named so the runtime's health report is legible", () => {
    expect(capability().capability.name).toBe("corpus");
  });

  test("start does not open the catalog — no file exists afterwards", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const { access } = await import("node:fs/promises");
    await expect(access(built_context.config.mirrorCatalogPath)).rejects.toBeDefined();
    await built.stop!();
  });

  test("reports an honest green when no archive is configured", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const mirror = (await built.healthChecks!()).find((check) => check.name === "corpus-mirror")!;
    expect(mirror.ok).toBe(true);
    expect(mirror.detail).toContain("no archives");
    // Nothing to do when you deliberately follow none.
    expect(mirror.remedy).toBeNull();
  });

  test("detects a sync position that outlived its catalog, and says how to repair it", async () => {
    // The wedge of Finding F11: the state file survives a catalog that no
    // longer holds the data it describes, so `returningSync` resumes past
    // records that are gone and imports nothing, forever.
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);

    // A position exists; the catalog was never populated.
    await createFileHighWaterMarkStore({
      filePath: built_context.config.mirrorStatePath,
      fs: corpusFs,
    }).put(
      { agent: source().agent, name: source().name },
      { sequence: "0000000000000009", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );

    const mirror = (await built.healthChecks!()).find((check) => check.name === "corpus-mirror")!;
    expect(mirror.ok).toBe(false);
    expect(mirror.detail).toContain("ahead of the catalog");
    expect(mirror.remedy).toContain(built_context.config.mirrorStatePath);
  });

  test("a fully trust-filtered catalog is NOT misreported as a wedged mirror", async () => {
    // `mirrorHasAnyRecord` reads the catalog raw for exactly this reason: an
    // unadmitted-producer catalog holds data, so it is not wedged, and the
    // trust story belongs to `corpus-trust-policy`.
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    await seedMirror(
      {
        catalogPath: built_context.config.mirrorCatalogPath,
        objectsDirectory: built_context.config.mirrorObjectsDirectory,
        fs: corpusFs,
      },
      source(),
    );
    await createFileHighWaterMarkStore({
      filePath: built_context.config.mirrorStatePath,
      fs: corpusFs,
    }).put(
      { agent: source().agent, name: source().name },
      { sequence: "0000000000000001", entry: `sha256:${"a".repeat(64)}`, issuedAt: "2026-07-30T00:00:00Z" },
    );

    const checks = await built.healthChecks!();
    // No trust policy is configured, so the reader admits nobody...
    expect((await built.reader.listRecords()).items).toEqual([]);
    // ...but the mirror itself is healthy, and only the trust row is red.
    expect(checks.find((check) => check.name === "corpus-mirror")!.ok).toBe(true);
    expect(checks.find((check) => check.name === "corpus-trust-policy")!.ok).toBe(false);
  });

  test("NO CHECK IS A RELEASE NOTE: every emitted check can vary by install", async () => {
    // C5's own scan of the rule Finding F9 established. A check whose `ok` is
    // the same on every possible install is a release note; it belongs in
    // `detail` or in the doctor's trailing render, not in the pass/fail set.
    // An earlier draft's `corpus-sources` failed this and was removed.
    const empty = capability();
    await empty.capability.start!(empty.context);
    const withArchives = capability({ corpus: { sources: [source()] } });
    await withArchives.capability.start!(withArchives.context);

    const a = await empty.capability.healthChecks!();
    const b = await withArchives.capability.healthChecks!();

    expect(a.map((check) => check.name).sort()).toEqual([
      "corpus-chain-verification",
      "corpus-mirror",
      "corpus-trust-policy",
    ]);
    // At least one check must disagree between the two installs, and no check
    // may be pinned green-or-red for all of them.
    const differing = a.filter(
      (check) => b.find((other) => other.name === check.name)!.ok !== check.ok,
    );
    expect(differing.length).toBeGreaterThan(0);
  });

  test("reports the trust policy as not fixable from this machine when unresolvable", async () => {
    const built = createCorpusCapability({
      transport,
      fs: corpusFs,
      dsseVerifier: () => ({ validSignerKeyids: [] }),
      readPolicyVersions: async () => {
        throw new Error("policy directory unreadable");
      },
    });
    const built_context = context({
      corpus: {
        sources: [source()],
        trust: { genesisDigest: `sha256:${"a".repeat(64)}`, policyDirectory: "policy" },
      },
    });
    await built.start!(built_context);
    const checks = await built.healthChecks!();
    const trust = checks.find((check) => check.name === "corpus-trust-policy")!;
    expect(trust.ok).toBe(false);
    expect(trust.remedy).toBeNull();
  });

  test("an acknowledged unverified posture is GREEN and names itself plainly", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()], acknowledgeUnverifiedChain: true },
    });
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    // Green because the install is configured coherently and is doing what
    // the operator asked. The posture is still stated, not hidden.
    expect(chain.ok).toBe(true);
    expect(chain.detail).toContain("not verified");
    expect(chain.remedy).toBeNull();
  });

  test("RED means a real, fixable misconfiguration: the default posture with no driver composed", async () => {
    // The default is `verified`, and this composition root injected no
    // driver — so nothing is indexed, and BOTH exits are in the remedy.
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain("will not index");
    expect(chain.remedy).toContain("verification driver");
    expect(chain.remedy).toContain("acknowledgeUnverifiedChain");
  });

  test("green when there is nothing to verify — no archives configured", async () => {
    const { capability: built, context: built_context } = capability();
    await built.start!(built_context);
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(true);
  });

  test("health checks before start throw rather than lying", async () => {
    const { capability: built } = capability();
    await expect(built.healthChecks!()).rejects.toBeDefined();
  });

  test("exposes the three surfaces C6 and C7 consume", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    expect(typeof built.mirror.syncOnce).toBe("function");
    expect(typeof built.reader.listRecords).toBe("function");
    expect(typeof built.retrieval.fetchRecord).toBe("function");
  });

  test("FAIL-CLOSED: with no trust configuration nothing is admitted", async () => {
    const { capability: built, context: built_context } = capability({
      corpus: { sources: [source()] },
    });
    await built.start!(built_context);
    // Sync is skipped-or-failed, and even a populated mirror would read empty.
    const page = await built.reader.listRecords();
    expect(page.items).toEqual([]);
  });
});

describe("chain-verification postures", () => {
  test("VERIFIED is the default, and the injected driver is what decides", async () => {
    const entryDigest = `sha256:${"b".repeat(64)}` as const;
    const driver = driverReturning({
      status: "ok",
      head: {
        protocol: "jinn.record-discovery/1",
        origin: `${source().agent}/${source().name}`,
        sequence: "0000000000000001",
        entry: entryDigest,
        issuedAt: "2026-07-30T00:00:00Z",
        refreshBy: "2026-08-30T00:00:00Z",
      },
      advanced: { sequence: "0000000000000001", entry: entryDigest, issuedAt: "2026-07-30T00:00:00Z" },
    });
    // No `chainVerification` key: the posture below is the resolved default.
    const { capability: built, context: built_context } = overArchive({
      file: {},
      verifyDriver: driver,
    });
    expect(built_context.config.corpus.chainVerification).toBe("verified");

    await built.start!(built_context);
    const outcome = await built.mirror.syncOnce();

    expect(driver.calls).toHaveLength(1);
    expect(driver.calls[0]!.source).toEqual({ agent: source().agent, name: source().name });
    expect(outcome.sources[0]!.status).toBe("synced");
    expect(outcome.sources[0]!.indexed).toBeGreaterThan(0);

    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(true);
    expect(chain.detail).toContain("verified before indexing");
    expect(chain.remedy).toBeNull();
  });

  test("a source the driver refuses is not indexed, and health names it with the reason", async () => {
    const driver = driverReturning({ status: "unauthorized-signer" });
    const { capability: built, context: built_context } = overArchive({
      file: {},
      verifyDriver: driver,
    });
    await built.start!(built_context);

    const outcome = await built.mirror.syncOnce();
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      indexed: 0,
      failure: { code: "chain-verification-rejected", message: "unauthorized-signer" },
    });

    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain(`${source().agent}/${source().name}`);
    expect(chain.detail).toContain("unauthorized-signer");
    expect(chain.remedy).not.toBeNull();
  });

  test("VERIFIED refuses an unsigned head before the driver is ever asked", async () => {
    const driver = driverReturning({ status: "unauthorized-signer" });
    const { capability: built, context: built_context } = overArchive({
      file: {},
      verifyDriver: driver,
      signHead: false,
    });
    await built.start!(built_context);

    const outcome = await built.mirror.syncOnce();
    expect(driver.calls).toHaveLength(0);
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      failure: { code: "chain-verification-rejected", message: "head-unsigned" },
    });
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.detail).toContain("head-unsigned");
  });

  test("VERIFIED without a composed driver fails closed — it never degrades to unverified", async () => {
    const { capability: built, context: built_context } = overArchive({ file: {} });
    await built.start!(built_context);

    const outcome = await built.mirror.syncOnce();
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      indexed: 0,
      failure: { code: "chain-verification-rejected", message: "chain-verification-not-configured" },
    });
    expect((await built.reader.listRecords()).items).toEqual([]);
  });

  test("UNVERIFIED indexes without asking the driver, and says so in health", async () => {
    const driver = driverReturning({ status: "unauthorized-signer" });
    const { capability: built, context: built_context } = overArchive({
      file: { chainVerification: "unverified", acknowledgeUnverifiedChain: true },
      verifyDriver: driver,
    });
    await built.start!(built_context);

    const outcome = await built.mirror.syncOnce();
    expect(driver.calls).toHaveLength(0);
    expect(outcome.sources[0]!.indexed).toBeGreaterThan(0);

    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(true);
    expect(chain.detail).toContain("not verified");
    expect(chain.remedy).toBeNull();
  });

  test("REJECTING is reported as itself even when the acknowledgement flag is also set", async () => {
    // The two postures collapse to the same `mode` — rejecting verifies
    // nothing, so it calls itself `unverified` too. Reading that mode instead
    // of the configured posture rendered this install GREEN with a detail
    // claiming it was mirroring, while it admitted nothing.
    const { capability: built, context: built_context } = overArchive({
      file: { chainVerification: "rejecting", acknowledgeUnverifiedChain: true },
    });
    await built.start!(built_context);

    expect((await built.mirror.syncOnce()).sources[0]).toMatchObject({
      status: "failed",
      indexed: 0,
    });
    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain("rejecting");
    expect(chain.remedy).not.toBeNull();
  });

  test("REJECTING admits nothing even with a driver composed, and is RED while archives are followed", async () => {
    const driver = driverReturning({ status: "unauthorized-signer" });
    const { capability: built, context: built_context } = overArchive({
      file: { chainVerification: "rejecting" },
      verifyDriver: driver,
    });
    await built.start!(built_context);

    const outcome = await built.mirror.syncOnce();
    expect(driver.calls).toHaveLength(0);
    expect(outcome.sources[0]).toMatchObject({
      status: "failed",
      failure: { code: "chain-verification-rejected", message: "chain-verification-not-configured" },
    });

    const chain = (await built.healthChecks!()).find(
      (check) => check.name === "corpus-chain-verification",
    )!;
    expect(chain.ok).toBe(false);
    expect(chain.detail).toContain("rejecting");
    expect(chain.remedy).toContain("verified");
  });
});
