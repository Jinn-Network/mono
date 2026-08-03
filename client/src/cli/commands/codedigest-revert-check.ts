import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { createDiscoveryAPI } from '../../discovery/factory.js';
import type { DiscoveryAPI } from '../../discovery/types.js';
import { DiscoveryUnavailableError } from '../../discovery/types.js';
import { hashImplStateDir } from '../../harnesses/freeze.js';
import { LEARNER_PUBLIC_V1 } from '../../harnesses/hash-profile.js';
import {
  decideRevert,
  resolveRevertPolicy,
  type CodeDigestAggregate,
  type RevertPolicy,
} from '../../learner/revert-decision.js';

export interface CodedigestRevertCheckDeps {
  buildDiscovery: (configPath?: string) => DiscoveryAPI;
}

const PRODUCTION_DEPS: CodedigestRevertCheckDeps = {
  buildDiscovery: (configPath) => {
    const config = loadConfig(configPath);
    const chainId = config.network === 'testnet' ? 84532 : 8453;
    // Mirror the daemon's floor wiring (solver-plugins.ts discoveryApiFactory):
    // only rpcUrl + chainId are needed for the http primary; the floor is never
    // routed for getCodeDigestRewards (withFallback propagates the error).
    return createDiscoveryAPI(config.discovery ?? { mode: 'onchain' }, {
      rpcUrl: config.rpcUrl,
      chainId,
    });
  },
};

/**
 * A commit sha as it appears in the operator's local `improvePromotionsDir`
 * records: 7-64 hex chars (abbreviated through full git object ids). Rejecting
 * anything else BEFORE handing the value to `git archive` closes the
 * argument-injection class where a leading-dash value (`--output=...`,
 * `--remote=...`) is parsed as a git option instead of a tree-ish (#764 M1).
 */
const COMMIT_SHA_RE = /^[0-9a-fA-F]{7,64}$/;

export function isValidCommitSha(sha: string): boolean {
  return COMMIT_SHA_RE.test(sha);
}

/**
 * Hash a commit's tree the way production stamps codeDigest: export the tree
 * with `git archive` (no `.git`) and re-hash with the same deterministic hasher
 * `hashImplStateDir` uses, under the learner's `learner-public.v1` profile.
 * Returns the `sha256:`-prefixed digest the indexer stores. Keeping this in TS
 * means the Consolidator prompt never reimplements the hasher (the single
 * largest correctness risk, #764).
 *
 * The profile is load-bearing here, not cosmetic: production stamps profile
 * digests as of #2118, so a re-hash under any other exclusion set would never
 * match an indexed digest and every revert lookup would miss.
 */
export async function codeDigestForCommit(implStateDir: string, sha: string): Promise<string> {
  if (!isValidCommitSha(sha)) {
    throw new Error(`commit sha must be 7-64 hex chars (got "${sha}")`);
  }
  const exportDir = mkdtempSync(join(tmpdir(), 'cd-export-'));
  try {
    // `--` is an end-of-options separator: even though `sha` is shape-validated
    // above, this is defense-in-depth so `git archive` can never parse a
    // leading-dash value as an option (#764 M1, git argument-injection class).
    const tar = execFileSync('git', ['archive', '--', sha], { cwd: implStateDir, maxBuffer: 1 << 28 });
    execFileSync('tar', ['-x', '-C', exportDir], { input: tar });
    const hex = await hashImplStateDir(exportDir, { profile: LEARNER_PUBLIC_V1 });
    return `sha256:${hex}`;
  } finally {
    rmSync(exportDir, { recursive: true, force: true });
  }
}

/**
 * Validate the optional numeric CLI flags (#764 M1). Each is only checked when
 * the operator actually provided it (omitted → policy default applies). Returns
 * the first failure, or `undefined` when all provided flags are in range.
 *   - min-samples: finite integer >= 1
 *   - window:      finite integer >= 1
 *   - alpha:       finite number in the open interval (0, 1)
 */
export function validateNumericFlags(flags: {
  minSamples?: string;
  window?: string;
  alpha?: string;
}): { field: string; message: string } | undefined {
  const isPositiveInt = (n: number): boolean => Number.isFinite(n) && Number.isInteger(n) && n >= 1;

  if (flags.minSamples !== undefined) {
    const n = Number(flags.minSamples);
    if (!isPositiveInt(n)) {
      return { field: 'min-samples', message: `--min-samples must be a finite integer >= 1 (got "${flags.minSamples}")` };
    }
  }
  if (flags.window !== undefined) {
    const n = Number(flags.window);
    if (!isPositiveInt(n)) {
      return { field: 'window', message: `--window must be a finite integer >= 1 (got "${flags.window}")` };
    }
  }
  if (flags.alpha !== undefined) {
    const n = Number(flags.alpha);
    if (!Number.isFinite(n) || n <= 0 || n >= 1) {
      return { field: 'alpha', message: `--alpha must be a finite number in (0, 1) (got "${flags.alpha}")` };
    }
  }
  return undefined;
}

function toAggregate(
  codeDigest: string,
  rows: Array<{ codeDigest: string; attempts: number; passes: number; passRate: number; gradedScores?: number[] }>,
): CodeDigestAggregate {
  const found = rows.find((r) => r.codeDigest === codeDigest);
  if (!found) return { codeDigest, attempts: 0, passes: 0, passRate: 0, gradedScores: [] };
  // A v1 indexer (pre-#1019 migration) returns rows without gradedScores.
  // Default to [] — mirroring the not-found branch — so decideRevert's Tier-2
  // readiness check sees an empty arm and falls back to the binary signal
  // rather than dereferencing `undefined.length` (§5.6 0.1.0↔0.2.0 boundary).
  return { codeDigest, attempts: found.attempts, passes: found.passes, passRate: found.passRate, gradedScores: found.gradedScores ?? [] };
}

export function createCodedigestRevertCheckCommand(
  deps: CodedigestRevertCheckDeps = PRODUCTION_DEPS,
): CommandModule {
  return {
    name: 'codedigest-revert-check',
    summary: 'Decide whether an Improve commit regressed the pass rate (per-codeDigest, #764)',
    helpText: `Usage:
  jinn codedigest-revert-check --code-digest <sha256:...> --parent-code-digest <sha256:...> [options]
  jinn codedigest-revert-check --impl-state-dir <path> --commit <sha> --parent <sha> [options]

Options:
  --operator 0x..       Restrict aggregates to attempts this operator Safe claimed
  --solvernet <cid>     Restrict to a SolverNet manifest CID
  --min-samples N       Minimum indexed attempts per arm (default 30)
  --alpha A             Two-sided significance threshold (default 0.05)
  --window N            Recent-attempts window per codeDigest (default 200)
  --json                Emit JSON (default)

Either pass two codeDigests directly, OR pass --impl-state-dir + --commit + --parent
to have the command export each commit's tree (git archive, no .git) and hash it
the way production stamps codeDigest — so the caller never reimplements the hasher.

Emits a JSON decision: { withCommit, atParent, delta, pValue, significant, recommendRevert, reason }.
On indexer outage emits recommendRevert=false reason=discovery_unavailable (the Consolidator then skips reverts).`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: {
            'code-digest': { type: 'string' },
            'parent-code-digest': { type: 'string' },
            'impl-state-dir': { type: 'string' },
            commit: { type: 'string' },
            parent: { type: 'string' },
            operator: { type: 'string' },
            solvernet: { type: 'string' },
            'min-samples': { type: 'string' },
            alpha: { type: 'string' },
            window: { type: 'string' },
            config: { type: 'string' },
            json: { type: 'boolean', default: true },
          },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn codedigest-revert-check --code-digest sha256:.. --parent-code-digest sha256:..',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      // Resolve the two codeDigests — either supplied directly or hashed from
      // an impl-state-dir git history.
      let child = parsed.values['code-digest'];
      let parent = parsed.values['parent-code-digest'];
      const implStateDir = parsed.values['impl-state-dir'];
      const commitSha = parsed.values.commit;
      const parentSha = parsed.values.parent;
      if ((!child || !parent) && implStateDir && commitSha && parentSha) {
        // Validate sha shape before any git invocation. A leading-dash value
        // would be parsed by `git archive` as an option, not a tree-ish
        // (#764 M1 argument-injection). Reject with the command's existing
        // invalid_invocation envelope (exit 11) rather than letting it flow
        // into git.
        const badSha = !isValidCommitSha(commitSha)
          ? { field: 'commit', value: commitSha }
          : !isValidCommitSha(parentSha)
            ? { field: 'parent', value: parentSha }
            : undefined;
        if (badSha) {
          emitEnvelope(
            {
              code: 'invalid_invocation',
              message: `--${badSha.field} sha must be 7-64 hex chars (got "${badSha.value}")`,
              exampleCli: 'jinn codedigest-revert-check --impl-state-dir <path> --commit <sha> --parent <sha>',
              details: { field: badSha.field },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
        try {
          [child, parent] = await Promise.all([
            codeDigestForCommit(implStateDir, commitSha),
            codeDigestForCommit(implStateDir, parentSha),
          ]);
        } catch (err) {
          emitEnvelope(
            {
              code: 'invalid_invocation',
              message: `failed to hash commit trees: ${err instanceof Error ? err.message : String(err)}`,
              exampleCli: 'jinn codedigest-revert-check --impl-state-dir <path> --commit <sha> --parent <sha>',
              details: { field: 'impl-state-dir' },
            },
            { writer: ctx.writer, exit: ctx.exit },
          );
          return;
        }
      }
      if (!child || !parent) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message:
              'provide either --code-digest + --parent-code-digest, or --impl-state-dir + --commit + --parent',
            exampleCli: 'jinn codedigest-revert-check --code-digest sha256:.. --parent-code-digest sha256:..',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      // Validate provided numeric flags. `Number('abc')` is NaN, `--alpha 0`
      // silently disables every revert, `--window 0` is nonsensical — reject
      // out-of-range input with the command's existing invalid_invocation
      // envelope (exit 11) rather than letting a bad value flow into the policy.
      const numErr = validateNumericFlags({
        minSamples: parsed.values['min-samples'],
        window: parsed.values.window,
        alpha: parsed.values.alpha,
      });
      if (numErr) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: numErr.message,
            exampleCli: 'jinn codedigest-revert-check --code-digest sha256:.. --parent-code-digest sha256:.. --alpha 0.05 --window 200 --min-samples 30',
            details: { field: numErr.field },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const policy: RevertPolicy = resolveRevertPolicy({
        ...(parsed.values['min-samples'] ? { minSamplesPerArm: Number(parsed.values['min-samples']) } : {}),
        ...(parsed.values.alpha ? { alpha: Number(parsed.values.alpha) } : {}),
        ...(parsed.values.window ? { recentAttemptsWindow: Number(parsed.values.window) } : {}),
      });

      const discovery = deps.buildDiscovery(parsed.values.config);
      let rows;
      try {
        rows = await discovery.getCodeDigestRewards({
          codeDigests: [child, parent],
          window: policy.recentAttemptsWindow,
          ...(parsed.values.operator ? { operator: parsed.values.operator as `0x${string}` } : {}),
          ...(parsed.values.solvernet ? { solverNetManifestCid: parsed.values.solvernet } : {}),
        });
      } catch (err) {
        if (err instanceof DiscoveryUnavailableError) {
          ctx.writer.write(
            JSON.stringify({ recommendRevert: false, reason: 'discovery_unavailable', message: err.message }) + '\n',
          );
          return;
        }
        throw err;
      }

      const decision = decideRevert(
        { withCommit: toAggregate(child, rows), atParent: toAggregate(parent, rows) },
        policy,
      );
      ctx.writer.write(JSON.stringify(decision) + '\n');
    },
  };
}

const command: CommandModule = createCodedigestRevertCheckCommand();
export default command;
