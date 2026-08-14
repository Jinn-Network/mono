import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const lifecyclePath = resolve(coreRoot, "quickstart/sample-lifecycle.mjs");
const harnessRoots: string[] = [];
const bundleIdentity = "a".repeat(64);
const checks = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
];

interface SampleLifecycleModule {
  readonly SAMPLE_LIFECYCLE_MODES: { readonly PRODUCT_DEMO: string };
  readonly runSampleLifecycle: (options: Record<string, unknown>) => unknown;
}

async function lifecycle(): Promise<SampleLifecycleModule> {
  return import(lifecyclePath) as Promise<SampleLifecycleModule>;
}

function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bp-demo-lifecycle-test-"));
  harnessRoots.push(root);
  return root;
}

function stagingRoots(base: string): string[] {
  return readdirSync(base).filter((entry) => entry.startsWith("benchmark-product-public-quickstart-"));
}

function fakeCommand(observed: { verifiedAfterCopy?: boolean; workspace?: string }, failAt?: string) {
  return ({ label, argv, workspaceDir }: { label: string; argv: string[]; workspaceDir: string }) => {
    observed.workspace = workspaceDir;
    if (label === "init") mkdirSync(workspaceDir, { recursive: false, mode: 0o700 });
    if (label === "publish") {
      const sourceBundle = join(
        workspaceDir,
        "artifacts",
        "public-quickstart",
        "public-bundles",
        bundleIdentity,
      );
      mkdirSync(sourceBundle, { recursive: true });
      writeFileSync(join(sourceBundle, "bundle.json"), "{\"fixture\":true}\n");
    }
    if (label === "standalone copied-bundle verify") {
      const bundle = argv[argv.indexOf("--bundle") + 1]!;
      observed.verifiedAfterCopy = existsSync(bundle)
        && !existsSync(workspaceDir)
        && existsSync(join(bundle, "bundle.json"));
    }
    if (label === failAt) throw new Error(`injected ${label} failure`);
    if (label === "sample init") return { benchmarkSha256: "b".repeat(64) };
    if (label === "quote") return { quote: { expectedCellCount: 6 } };
    if (label === "lock") return { runSha256: "c".repeat(64) };
    if (label === "resume") return { outstandingCount: 0 };
    if (label === "status after resume") return { counts: { expected: 6 } };
    if (label === "collect") return { matrixSha256: "d".repeat(64) };
    if (label === "results") return { completeness: { runOutcome: "complete" } };
    if (label === "report") return { reportSha256: "e".repeat(64) };
    if (label === "workspace verify" || label === "standalone copied-bundle verify") {
      return { checks, identity: bundleIdentity };
    }
    if (label === "publish") {
      return {
        checks,
        bundleIdentity,
        bundleRelativePath: `artifacts/public-quickstart/public-bundles/${bundleIdentity}`,
      };
    }
    return {};
  };
}

afterEach(() => {
  for (const root of harnessRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("retained first-run sample lifecycle", () => {
  it("retains a copied bundle, deletes staging source, and verifies only after the copy", async () => {
    const api = await lifecycle();
    const base = harnessRoot();
    const outputRoot = join(base, "my-first-colophon-run");
    const observed: { verifiedAfterCopy?: boolean; workspace?: string } = {};
    const events: unknown[] = [];

    const result = api.runSampleLifecycle({
      mode: api.SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO,
      outputRoot,
      temporaryBase: base,
      prepareBuild: () => {},
      executeCommand: fakeCommand(observed),
      onProgress: (event: unknown) => events.push(event),
    }) as {
      output: { root: string; bundle: string; retained: boolean };
      sourceWorkspaceDeleted: boolean;
      conclusion: string;
      sampleContract: { accountRequired: boolean; apiKeyRequired: boolean; fundsRequired: boolean; dockerRequired: boolean; providerCallsMade: boolean };
    };

    expect(result.output).toEqual({ root: outputRoot, bundle: join(outputRoot, "bundle"), retained: true });
    expect(result.sourceWorkspaceDeleted).toBe(true);
    expect(result.conclusion).toMatch(/does not establish a comparative winner/i);
    expect(result.sampleContract).toEqual({
      accountRequired: false,
      apiKeyRequired: false,
      fundsRequired: false,
      dockerRequired: false,
      providerCallsMade: false,
    });
    expect(existsSync(join(outputRoot, "bundle", "bundle.json"))).toBe(true);
    expect(observed.verifiedAfterCopy).toBe(true);
    expect(existsSync(observed.workspace!)).toBe(false);
    expect(stagingRoots(base)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: true });
  });

  it("refuses existing and linked output targets before building or staging", async () => {
    const api = await lifecycle();
    const base = harnessRoot();
    const existing = join(base, "existing");
    mkdirSync(existing);
    const outside = join(base, "outside");
    mkdirSync(outside);
    const linked = join(base, "linked");
    symlinkSync(outside, linked, "dir");
    let builds = 0;

    for (const outputRoot of [existing, linked]) {
      expect(() => api.runSampleLifecycle({
        mode: api.SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO,
        outputRoot,
        temporaryBase: base,
        prepareBuild: () => { builds += 1; },
      })).toThrow(/already exists|linked/i);
    }
    expect(builds).toBe(0);
    expect(existsSync(existing)).toBe(true);
    expect(existsSync(outside)).toBe(true);
    expect(stagingRoots(base)).toEqual([]);
  });

  it("cleans disposable staging after a failure while retaining the copied bundle", async () => {
    const api = await lifecycle();
    const base = harnessRoot();
    const outputRoot = join(base, "failed-demo");
    const observed: { verifiedAfterCopy?: boolean; workspace?: string } = {};
    const events: unknown[] = [];

    expect(() => api.runSampleLifecycle({
      mode: api.SAMPLE_LIFECYCLE_MODES.PRODUCT_DEMO,
      outputRoot,
      temporaryBase: base,
      prepareBuild: () => {},
      executeCommand: fakeCommand(observed, "standalone copied-bundle verify"),
      onProgress: (event: unknown) => events.push(event),
    })).toThrow(/injected standalone copied-bundle verify failure/);

    expect(existsSync(join(outputRoot, "bundle", "bundle.json"))).toBe(true);
    expect(existsSync(observed.workspace!)).toBe(false);
    expect(stagingRoots(base)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "result", ok: false });
  });
});
