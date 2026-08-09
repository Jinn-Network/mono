import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface IdentityBoundOwner {
  readonly root: string;
  readonly markerPath: string;
  readonly markerBytes: string;
}

interface OwnershipModule {
  readonly createOwnedRoot: (options: { temporaryBase: string }) => IdentityBoundOwner;
  readonly captureOwnedWorkspace: (owner: IdentityBoundOwner, path: string) => void;
  readonly removeOwnedWorkspace: (owner: IdentityBoundOwner, path: string) => void;
  readonly removeOwnedRoot: (owner: IdentityBoundOwner) => void;
  readonly combinePrimaryAndCleanupFailure: (primary: unknown, cleanup: unknown) => unknown;
}

const harnessRoots: string[] = [];

async function ownership(): Promise<OwnershipModule> {
  // The production runner imports this same narrow JavaScript seam.
  // @ts-expect-error -- the executable .mjs seam intentionally has no packed TypeScript surface.
  return import("../quickstart/ownership.mjs") as Promise<OwnershipModule>;
}

function harnessRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bp51-quickstart-cleanup-test-"));
  harnessRoots.push(root);
  return root;
}

function quarantineEntries(parent: string): readonly string[] {
  return readdirSync(parent)
    .filter((name) => name.includes(".quarantine-"))
    .map((name) => join(parent, name));
}

afterEach(() => {
  for (const root of harnessRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public quickstart identity-bound cleanup", () => {
  it("never deletes a same-path root replacement with a copied marker", async () => {
    const api = await ownership();
    const base = harnessRoot();
    const owner = api.createOwnedRoot({ temporaryBase: base });
    const displacedOriginal = join(base, "displaced-original-root");
    renameSync(owner.root, displacedOriginal);
    mkdirSync(owner.root, { mode: 0o700 });
    writeFileSync(join(owner.root, basename(owner.markerPath)), owner.markerBytes, { mode: 0o600 });
    writeFileSync(join(owner.root, "replacement-evidence.txt"), "do not delete\n");

    expect(() => api.removeOwnedRoot(owner)).toThrow(/identity.*retained|retained.*identity/i);
    expect(existsSync(displacedOriginal)).toBe(true);
    expect(lstatSync(owner.root).isSymbolicLink()).toBe(true);
    const quarantines = quarantineEntries(base);
    expect(quarantines).toHaveLength(1);
    expect(readFileSync(join(quarantines[0]!, "replacement-evidence.txt"), "utf8")).toBe("do not delete\n");
  });

  it("never deletes a same-path workspace replacement and blocks enclosing-root cleanup", async () => {
    const api = await ownership();
    const base = harnessRoot();
    const owner = api.createOwnedRoot({ temporaryBase: base });
    const workspace = join(owner.root, "source-workspace");
    mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(join(workspace, "original.txt"), "original\n");
    api.captureOwnedWorkspace(owner, workspace);
    renameSync(workspace, join(owner.root, "displaced-original-workspace"));
    mkdirSync(workspace, { mode: 0o700 });
    writeFileSync(join(workspace, "replacement-evidence.txt"), "do not delete\n");

    expect(() => api.removeOwnedWorkspace(owner, workspace)).toThrow(/identity.*retained|retained.*identity/i);
    expect(lstatSync(workspace).isSymbolicLink()).toBe(true);
    expect(() => api.removeOwnedRoot(owner)).toThrow(/blocked.*unproven|unproven.*blocked/i);
    expect(quarantineEntries(owner.root)).toHaveLength(1);
  });

  it.each([
    ["stale", `${JSON.stringify({ format: "benchmark-product-public-quickstart-owner/1", token: "stale" })}\n`],
    ["malformed", "{malformed\n"],
  ])("retains evidence for a %s ownership marker", async (_label, replacement) => {
    const api = await ownership();
    const base = harnessRoot();
    const owner = api.createOwnedRoot({ temporaryBase: base });
    writeFileSync(owner.markerPath, replacement);

    expect(() => api.removeOwnedRoot(owner)).toThrow(/marker.*retained|retained.*marker/i);
    expect(lstatSync(owner.root).isSymbolicLink()).toBe(true);
    expect(quarantineEntries(base)).toHaveLength(1);
  });

  it.each(["symlink", "hardlink"])("retains evidence for a marker %s replacement", async (kind) => {
    const api = await ownership();
    const base = harnessRoot();
    const owner = api.createOwnedRoot({ temporaryBase: base });
    const outside = join(base, `outside-${kind}.json`);
    writeFileSync(outside, owner.markerBytes, { mode: 0o600 });
    rmSync(owner.markerPath);
    if (kind === "symlink") symlinkSync(outside, owner.markerPath);
    else linkSync(outside, owner.markerPath);

    expect(() => api.removeOwnedRoot(owner)).toThrow(/marker.*retained|retained.*marker/i);
    expect(existsSync(outside)).toBe(true);
    expect(quarantineEntries(base)).toHaveLength(1);
  });

  it("keeps parallel invocation roots unique and cleanup-isolated", async () => {
    const api = await ownership();
    const base = harnessRoot();
    const owners = await Promise.all([
      Promise.resolve().then(() => api.createOwnedRoot({ temporaryBase: base })),
      Promise.resolve().then(() => api.createOwnedRoot({ temporaryBase: base })),
    ]);
    expect(owners[0]!.root).not.toBe(owners[1]!.root);

    api.removeOwnedRoot(owners[0]!);
    expect(existsSync(owners[0]!.root)).toBe(false);
    expect(existsSync(owners[1]!.root)).toBe(true);
    api.removeOwnedRoot(owners[1]!);
    expect(existsSync(owners[1]!.root)).toBe(false);
  });

  it("retains both the primary and cleanup failure", async () => {
    const api = await ownership();
    const combined = api.combinePrimaryAndCleanupFailure(
      new Error("primary operation failed"),
      new Error("cleanup refused and retained evidence"),
    );
    expect(combined).toBeInstanceOf(Error);
    expect((combined as Error).message).toContain("primary operation failed");
    expect((combined as Error).message).toContain("cleanup refused and retained evidence");
    expect((combined as Error & { cause?: unknown }).cause).toBeInstanceOf(AggregateError);
  });
});
