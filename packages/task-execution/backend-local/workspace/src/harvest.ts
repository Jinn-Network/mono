import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  DeclaredOutputSlot, HarvestResult, IntegrityViolation, OutputArtifact, WorkspacePaths,
} from "./contract.js";
import { compareCodeUnitStrings } from "./order.js";
import { BACKEND_WRITTEN_LOG_FILENAMES } from "./harness-logs.js";

function contained(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

function digestFile(path: string, reportedPath: string, root: string): OutputArtifact | IntegrityViolation {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!contained(realpathSync(path), root)) return { path: reportedPath, reason: "symlink-escape" };
    const bytes = readFileSync(fd);
    return {
      path: reportedPath,
      sizeBytes: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } catch {
    return { path: reportedPath, reason: "nofollow-open-failed" };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function walk(
  directory: string,
  root: string,
  prefix: string,
  manifest: OutputArtifact[],
  violations: IntegrityViolation[],
): void {
  for (const name of readdirSync(directory).sort(compareCodeUnitStrings)) {
    const path = resolve(directory, name);
    const reported = prefix ? `${prefix}/${name}` : name;
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      violations.push({ path: reported, reason: "symlink-escape" });
      continue;
    }
    if (!contained(realpathSync(path), root)) {
      violations.push({ path: reported, reason: "path-escape" });
      continue;
    }
    if (status.isDirectory()) {
      let fd: number | undefined;
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        walk(path, root, reported, manifest, violations);
      } catch {
        violations.push({ path: reported, reason: "nofollow-open-failed" });
      } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
      }
    } else if (status.isFile()) {
      const entry = digestFile(path, reported, root);
      if ("reason" in entry) violations.push(entry);
      else manifest.push(entry);
    }
  }
}

function inputViolations(paths: WorkspacePaths): IntegrityViolation[] {
  const snapshotPath = join(paths.meta, "input-manifest.json");
  if (!existsSync(snapshotPath)) return [];
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, string>;
  const current: OutputArtifact[] = [];
  const failures: IntegrityViolation[] = [];
  walk(paths.input, realpathSync(paths.input), "", current, failures);
  const actual = new Map(current.map((entry) => [entry.path, entry.sha256]));
  const names = [...new Set([...Object.keys(expected), ...actual.keys()])].sort(compareCodeUnitStrings);
  return [
    ...failures,
    ...names.flatMap((name) => expected[name] === actual.get(name)
      ? [] : [{ path: name, reason: "input-mutated" }]),
  ];
}

/** Deterministic collection. Process-group gating and cleanup are provisioner-owned wrappers. */
export async function harvest(
  paths: WorkspacePaths,
  declaredOutputs: readonly DeclaredOutputSlot[],
): Promise<HarvestResult> {
  const manifest: OutputArtifact[] = [];
  const integrityViolations: IntegrityViolation[] = [];
  const outRoot = realpathSync(paths.out);
  walk(outRoot, outRoot, "", manifest, integrityViolations);
  if (existsSync(paths.logs)) {
    const logsRoot = realpathSync(paths.logs);
    walk(logsRoot, logsRoot, "logs", manifest, integrityViolations);
    // #2538 F5: the backend's own capture of the harness's stdio is backend state, like `meta/`,
    // not an executor Result. Collecting it would put whatever the harness printed into every
    // signed Delivery's `outputs`. Anything the HARNESS writes under `logs/` is still collected.
    for (const name of BACKEND_WRITTEN_LOG_FILENAMES) {
      const reported = `logs/${name}`;
      const index = manifest.findIndex((entry) => entry.path === reported);
      if (index >= 0) manifest.splice(index, 1);
    }
  }
  manifest.sort((a, b) => compareCodeUnitStrings(a.path, b.path));
  integrityViolations.push(...inputViolations(paths));
  integrityViolations.sort((a, b) => compareCodeUnitStrings(a.path, b.path));
  const names = new Set(manifest.map((entry) => entry.path));
  const omissions = declaredOutputs
    .filter((output) => !names.has(output.name))
    .map((output) => output.name)
    .sort(compareCodeUnitStrings);
  return { manifest, omissions, integrityViolations };
}
