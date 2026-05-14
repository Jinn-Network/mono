/**
 * Conformance report shapes.
 *
 * Scope: docs/superpowers/specs/2026-04-23-jinn-execution-envelope-tee-scope.md §4.10.
 *
 * A ConformanceReport is the output of running the harness against an envelope
 * CID. Layer 1 checks apply at every tier (structural). Layer 2 checks apply
 * only at the `attested` tier (traced-I/O boundary). Layer 2 runtime checks
 * are stubbed in V1 (skipped); Layer 2 static checks run fully.
 */

import type { EvidenceTier, SignedEnvelope } from '../types/envelope.js';
import type { Task } from '../types/task.js';

export interface CheckResult {
  /** Dotted identifier: `<area>.<check>` — e.g. `envelope.schema`, `trajectory.hash-chain`. */
  id: string;
  /** Layer 1 = structural; Layer 2 = attested-tier traced-I/O boundary. */
  layer: 1 | 2;
  /** Whether the check passed. A skipped check is considered passing for overall verdict purposes. */
  passed: boolean;
  /** Set to true when the check was intentionally not run (e.g. Layer 2 at non-attested tier, or V1 runtime stub). */
  skipped?: boolean;
  /** Short human-readable reason on failure. */
  detail?: string;
}

export type Overall = 'PASS' | 'FAIL' | 'SKIP';

export interface ConformanceSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ConformanceReport {
  envelopeCid: string;
  envelopeTier: EvidenceTier;
  checks: CheckResult[];
  summary: ConformanceSummary;
  overall: Overall;
  layer1Passed: boolean;
  /** 'N/A' when envelopeTier !== 'attested'. */
  layer2Passed: boolean | 'N/A';
}

export interface ConformanceOptions {
  /** Skip Layer 2 source-bundle static checks even at attested tier. Useful during plan-D-only dogfood. */
  skipLayer2?: boolean;
  /** Override IPFS gateway URL (defaults to config). */
  ipfsGatewayUrl?: string;
  /** Override IPFS registry URL (defaults to config). */
  ipfsRegistryUrl?: string;
  /** Pre-fetched envelope bytes (skip IPFS fetch). */
  envelopeBytes?: Buffer | Uint8Array;
  /** Pre-loaded Task (skip IPFS fetch). */
  task?: Task;
  /** Pre-fetched trajectory bytes (skip IPFS fetch). */
  trajectoryBytes?: Buffer | Uint8Array;
  /** Pre-loaded trajectory (skip IPFS fetch). */
  trajectory?: unknown;
  /** Pre-fetched solution envelope bytes (skip IPFS fetch). */
  solutionEnvelopeBytes?: Buffer | Uint8Array;
  /** Legacy alias for solutionEnvelopeBytes. */
  restorationEnvelopeBytes?: Buffer | Uint8Array;
  /** Pre-loaded source bundle (skip IPFS fetch). */
  sourceBundle?: { files: Map<string, string>; manifest?: Record<string, unknown> };
}

/**
 * ConformanceContext carries pre-fetched objects between checks so each
 * check doesn't re-fetch from IPFS. The harness populates this incrementally
 * as checks pass.
 */
export interface ConformanceContext {
  envelopeCid: string;
  envelopeBytes?: Uint8Array;
  rawEnvelope?: Record<string, unknown>;
  envelope?: SignedEnvelope;
  task?: Task;
  trajectoryBytes?: Uint8Array;
  trajectory?: unknown; // typed after Plan D schema lands
  sourceBundle?: { files: Map<string, string>; manifest?: Record<string, unknown> };
  /** Pre-fetched bytes of the referenced solution envelope (for verdict checks). */
  solutionEnvelopeBytes?: Uint8Array;
  /** Legacy alias for solutionEnvelopeBytes. */
  restorationEnvelopeBytes?: Uint8Array;
  /** Pre-loaded solution envelope object (for verdict checks). */
  solutionEnvelope?: SignedEnvelope;
  /** Legacy alias for solutionEnvelope. */
  restorationEnvelope?: SignedEnvelope;
  options: ConformanceOptions;
}

export function summarize(checks: CheckResult[]): ConformanceSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const c of checks) {
    if (c.skipped) skipped++;
    else if (c.passed) passed++;
    else failed++;
  }
  return { total: checks.length, passed, failed, skipped };
}

export function overallFromChecks(checks: CheckResult[]): Overall {
  if (checks.length === 0) return 'SKIP';
  const anyFailed = checks.some((c) => !c.skipped && !c.passed);
  return anyFailed ? 'FAIL' : 'PASS';
}
