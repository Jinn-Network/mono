/**
 * Pure helpers for the swe-rebench-v2 admission record's substrate-identity
 * fields (`rowHash`, `imageDigest`, `upstreamEvalCommit`). v3 of
 * EVAL_SEMANTICS_VERSION (see _swe-rebench-v2-validated-pool.ts).
 *
 * These are extracted from `validatePoolInstances` so they can be unit-tested
 * independently and reused by the verdict-time substrate recheck in the
 * evaluator harness.
 */

import { createHash } from 'node:crypto';

export interface RowHashInput {
  hf_dataset: string;
  hf_split: string;
  instance_id: string;
  repo: string;
  base_commit: string;
  image_name: string;
  patch: string;
  test_patch: string;
  install_config: {
    install: string[] | string;
    test_cmd: string[] | string;
    log_parser: string;
  };
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
}

/**
 * Canonical-JSON SHA-256 over the HF row fields that affect grading.
 * Keys are sorted recursively so field-reorder produces the same hash.
 * Output is `sha256:<lowercase-hex>` (RFC 8785 JCS-compatible for these
 * primitive types — no float / Date / BigInt in the row).
 */
export function computeRowHash(row: RowHashInput): string {
  const canonical = JSON.stringify(row, sortedKeys);
  const hex = createHash('sha256').update(canonical).digest('hex');
  return `sha256:${hex}`;
}

function sortedKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type CommandRunner = (
  bin: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<CommandResult>;

/**
 * Resolve the digest of a local Docker image via `docker image inspect`.
 * Returns null when docker fails or the image has no RepoDigests entry
 * (e.g. local-only images that haven't been pulled from a registry).
 */
export async function resolveImageDigest(
  imageName: string,
  runner: CommandRunner,
): Promise<string | null> {
  const res = await runner('docker', [
    'image', 'inspect', imageName, '--format', '{{json .RepoDigests}}',
  ]);
  if (res.exitCode !== 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(res.stdout.trim()); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const first = parsed[0];
  if (typeof first !== 'string') return null;
  // `RepoDigests` entries are `<name>@sha256:<hex>`; strip the name.
  const at = first.indexOf('@');
  if (at === -1) return null;
  const digest = first.slice(at + 1);
  // Docker `RepoDigests` entries are `<name>@sha256:<hex>`. Refuse to accept
  // a malformed digest (e.g. `<name>@` or a non-sha256 algorithm); the call
  // site relies on the digest being a comparable `sha256:` value.
  return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
}

/**
 * Resolve the upstream SWE-rebench-V2 repo's HEAD commit via `git rev-parse`.
 * Returns null when git fails (not a repo, missing, etc.).
 */
export async function resolveUpstreamEvalCommit(
  upstreamRepoDir: string,
  runner: CommandRunner,
): Promise<string | null> {
  const res = await runner('git', ['rev-parse', 'HEAD'], { cwd: upstreamRepoDir });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
