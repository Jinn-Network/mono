import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface RuntimeWorkspace {
  readonly runId: string;
  readonly ownershipToken: string;
  readonly runRoot: string;
  readonly workspaceDir: string;
  readonly copiedBundleDir: string;
  readonly ownershipMarker: string;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function markerBytes(runtime: RuntimeWorkspace): string {
  return `${JSON.stringify({ format: "benchmark-product-browser-owner/1", runId: runtime.runId, ownershipToken: runtime.ownershipToken })}\n`;
}

export function deriveRuntimeWorkspace(input: {
  readonly baseDir: string;
  readonly runId: string;
  readonly ownershipToken: string;
}): RuntimeWorkspace {
  if (!RUN_ID.test(input.runId)) throw new Error("browser run id must be a UUID");
  if (!/^[A-Za-z0-9-]{8,128}$/u.test(input.ownershipToken)) throw new Error("browser ownership token is invalid");
  const runRoot = resolve(input.baseDir, `jinn-bp50-browser-${input.runId}`);
  return {
    runId: input.runId,
    ownershipToken: input.ownershipToken,
    runRoot,
    workspaceDir: join(runRoot, "workspace"),
    copiedBundleDir: join(runRoot, "copied-public-bundle"),
    ownershipMarker: join(runRoot, ".bp50-browser-owner.json"),
  };
}

/** Exclusive creation means a stale/crashed invocation is never reused or deleted implicitly. */
export function prepareRuntimeWorkspace(runtime: RuntimeWorkspace): void {
  mkdirSync(runtime.runRoot);
  try {
    writeFileSync(runtime.ownershipMarker, markerBytes(runtime), { flag: "wx", mode: 0o600 });
    mkdirSync(runtime.workspaceDir);
  } catch (cause) {
    rmSync(runtime.runRoot, { recursive: true, force: true });
    throw cause;
  }
}

/** Cleanup is allowed only for the exact UUID root and unmodified owner marker created above. */
export function cleanupRuntimeWorkspace(runtime: RuntimeWorkspace): void {
  const rootStat = lstatSync(runtime.runRoot);
  const markerStat = lstatSync(runtime.ownershipMarker);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1) {
    throw new Error("refusing browser cleanup without an exact regular ownership boundary");
  }
  if (readFileSync(runtime.ownershipMarker, "utf8") !== markerBytes(runtime)) {
    throw new Error("refusing browser cleanup because ownership marker does not match");
  }
  const resolvedRoot = realpathSync(runtime.runRoot);
  const resolvedBase = realpathSync(dirname(runtime.runRoot));
  if (dirname(resolvedRoot) !== resolvedBase || basename(resolvedRoot) !== `jinn-bp50-browser-${runtime.runId}`) {
    throw new Error("refusing browser cleanup outside the exact per-run root");
  }
  rmSync(resolvedRoot, { recursive: true, force: false });
}
