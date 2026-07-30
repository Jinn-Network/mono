import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BenchOutcome {
  instanceId: string;
  arm: string;
  repeat: number;
  /** null = ungradeable (never coerced to fail — mirrors ArmResult in packages/layer/src/measurement.ts). */
  passed: boolean | null;
  unscorable: boolean;
  costUsd: number;
}

export interface BenchManifest {
  version: 'skills-bench-manifest.v1';
  slateSha256: string;
  model: string;
  arms: { name: string; skillSha256: string | null }[];
}

export function attemptKey(o: { instanceId: string; arm: string; repeat: number }): string {
  return `${o.instanceId}|${o.arm}|${o.repeat}`;
}

export async function appendAttempt(file: string, o: BenchOutcome): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(o)}\n`);
}

export async function loadAttempts(file: string): Promise<BenchOutcome[]> {
  if (!existsSync(file)) return [];
  const byKey = new Map<string, BenchOutcome>();
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line) as BenchOutcome;
    byKey.set(attemptKey(o), o); // later wins — a rerun supersedes
  }
  return [...byKey.values()];
}

export async function assertManifestCompatible(file: string, manifest: BenchManifest): Promise<void> {
  if (!existsSync(file)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  const existing = await readFile(file, 'utf8');
  const wanted = `${JSON.stringify(manifest, null, 2)}\n`;
  if (existing !== wanted) {
    throw new Error(
      `skills-bench manifest mismatch: ${file} was written by a different configuration ` +
      `(slate, model, or arm bytes changed). Use a fresh --out dir for a changed run.`,
    );
  }
}
