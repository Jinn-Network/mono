import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { DeclaredOutputSlot, HarvestResult, IntegrityViolation, OutputArtifact, WorkspacePaths } from "./contract.js";
import { compareCodeUnitStrings } from "./order.js";

function contained(path: string, root: string): boolean { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/")); }

export async function harvest(paths: WorkspacePaths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult> {
  const root = realpathSync(paths.out);
  const manifest: OutputArtifact[] = [];
  const integrityViolations: IntegrityViolation[] = [];
  for (const name of readdirSync(root).sort(compareCodeUnitStrings)) {
    const path = resolve(root, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) { integrityViolations.push({ path: name, reason: "symlink-escape" }); continue; }
    if (!status.isFile()) continue;
    let fd: number | undefined;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { integrityViolations.push({ path: name, reason: "nofollow-open-failed" }); continue; }
    try {
      if (!contained(realpathSync(path), root)) { integrityViolations.push({ path: name, reason: "symlink-escape" }); continue; }
      const bytes = readFileSync(fd);
      manifest.push({ path: name, sizeBytes: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
    } finally { if (fd !== undefined) { try { closeSync(fd); } catch {} } }
  }
  const names = new Set(manifest.map((entry) => entry.path));
  return { manifest: [...manifest].sort((a, b) => compareCodeUnitStrings(a.path, b.path)), omissions: declaredOutputs.filter((output) => !names.has(output.name)).map((output) => output.name).sort(compareCodeUnitStrings), integrityViolations };
}
