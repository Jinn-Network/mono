import { basename, dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export type SessionEchoLiveMode = 'borrow-mismatch' | 'borrow-aligned';

export type SessionEchoLiveClassification =
  | 'admitted'
  | 'rejected:empirical-dead'
  | 'rejected:other'
  | 'infra-blocked';

export interface SessionEchoLiveClassifyInput {
  mode: SessionEchoLiveMode;
  admitted: string[];
  rejected: Array<{ instance_id: string; reason: string }>;
  /** Set when the attempt never reached a clean mint classification (prereq or runner infra). */
  infraError?: string;
}

export interface SessionEchoLiveClassifyResult {
  classification: SessionEchoLiveClassification;
  /** True when borrow-mismatch produced empirical-dead (hypothesis confirmed). Null when N/A. */
  hypothesisHolds: boolean | null;
  redFlag?: string;
}

export const DOCKER_INFO_TIMEOUT_MS = 20_000;

export interface DockerInfoProbeOptions {
  stdio: 'ignore';
  timeout: number;
}

export interface DockerInfoProbeResult {
  status: number | null;
  error?: { code?: string };
}

export type DockerInfoProbe = (
  args: string[],
  options: DockerInfoProbeOptions,
) => DockerInfoProbeResult;

export function dockerPreflightError(probe: DockerInfoProbe): string | null {
  let result: DockerInfoProbeResult;
  try {
    result = probe(['info'], {
      stdio: 'ignore',
      timeout: DOCKER_INFO_TIMEOUT_MS,
    });
  } catch (err) {
    return `Docker daemon probe failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (result.error?.code === 'ETIMEDOUT') {
    return `Docker daemon did not respond within ${DOCKER_INFO_TIMEOUT_MS / 1000}s`;
  }
  if (result.status !== 0) return 'Docker daemon not reachable';
  return null;
}

export function isGradedSessionEchoLiveClassification(
  classification: SessionEchoLiveClassification,
): boolean {
  return classification !== 'infra-blocked';
}

export function sessionEchoLiveProcessExitCode(
  result: SessionEchoLiveClassifyResult,
): number {
  if (result.redFlag) return 1;
  if (result.classification === 'infra-blocked') return 1;
  return 0;
}

export interface SessionEchoLivePriorSummary {
  classification: SessionEchoLiveClassification;
}

export interface SessionEchoLiveResultWritePlan {
  resultPath: string;
  preservedPriorGradedSoR: boolean;
}

export function readSessionEchoLivePriorSummary(
  canonicalPath: string,
): SessionEchoLivePriorSummary | null {
  if (!existsSync(canonicalPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(canonicalPath, 'utf8')) as {
      classification?: unknown;
    };
    if (
      parsed.classification === 'admitted'
      || parsed.classification === 'rejected:empirical-dead'
      || parsed.classification === 'rejected:other'
      || parsed.classification === 'infra-blocked'
    ) {
      return { classification: parsed.classification };
    }
  } catch {
    return null;
  }
  return null;
}

export function resolveSessionEchoLiveResultWrite(input: {
  canonicalPath: string;
  classified: SessionEchoLiveClassifyResult;
  prior?: SessionEchoLivePriorSummary | null;
  timestamp?: string;
}): SessionEchoLiveResultWritePlan {
  const preserve =
    input.prior != null
    && isGradedSessionEchoLiveClassification(input.prior.classification)
    && input.classified.classification === 'infra-blocked';

  if (!preserve) {
    return { resultPath: input.canonicalPath, preservedPriorGradedSoR: false };
  }

  const dir = dirname(input.canonicalPath);
  const base = basename(input.canonicalPath, '.json');
  const timestamp = input.timestamp ?? new Date().toISOString().replace(/[:.]/g, '-');
  return {
    resultPath: join(dir, `${base}-${timestamp}.json`),
    preservedPriorGradedSoR: true,
  };
}

export function seedIsolatedValidatedPool(
  operatorPoolPath: string,
  stateDir: string,
  copyFile: (source: string, destination: string) => void,
): string {
  copyFile(operatorPoolPath, join(stateDir, 'validated-pool.json'));
  return stateDir;
}

const EMPIRICAL_DEAD_RE = /empirical-dead/i;

/**
 * Operator-environment failures that may appear as thrown `infraError` *or*
 * as `mineSessionEchoes` rejection reasons (admission catches
 * `EvalCouldNotGradeError` / disk errors into `ungradeable:` / `error:` /
 * `transient:` buckets rather than always throwing).
 *
 * Deliberately excludes patch/product reasons (`patch_does_not_apply`,
 * `pytest_missing`, `gold-patch-not-resolved`, …) — those stay
 * `rejected:other`.
 */
const INFRA_REASON_RE =
  /(?:^|[\s(:])(?:ungradeable:|transient:|error:)?(?:docker_(?:unavailable|credentials_error|storage_io_error|run_failed)|image_pull_failed|image_arch_mismatch|venv_(?:missing|collision)|eval_timeout)(?:\b|$)|insufficient disk|Docker daemon (?:not reachable|did not respond)/i;

function looksLikeInfra(text: string | undefined): boolean {
  if (!text) return false;
  return INFRA_REASON_RE.test(text);
}

export function classifySessionEchoLiveResult(
  input: SessionEchoLiveClassifyInput,
): SessionEchoLiveClassifyResult {
  if (input.infraError) {
    return {
      classification: looksLikeInfra(input.infraError) ? 'infra-blocked' : 'rejected:other',
      hypothesisHolds: null,
    };
  }
  if (input.admitted.length > 0) {
    if (input.mode === 'borrow-mismatch') {
      return {
        classification: 'admitted',
        hypothesisHolds: false,
        redFlag:
          'worse-than-hypothesized: admitted under borrow-mismatch (borrowed tests are not the session tests)',
      };
    }
    return { classification: 'admitted', hypothesisHolds: null };
  }
  const reason = input.rejected[0]?.reason ?? '';
  if (looksLikeInfra(reason)) {
    return { classification: 'infra-blocked', hypothesisHolds: null };
  }
  if (EMPIRICAL_DEAD_RE.test(reason)) {
    return {
      classification: 'rejected:empirical-dead',
      hypothesisHolds: input.mode === 'borrow-mismatch' ? true : null,
    };
  }
  return {
    classification: 'rejected:other',
    // Zero-yield that is not empirical-dead: hypothesis neither confirmed nor
    // disproven (disproven only by admit-under-mismatch).
    hypothesisHolds: null,
  };
}
