import { createHash } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod/v3';
import type { CommandRunner } from './issue-source.js';
import { REPO } from './constants.js';

/**
 * Delivery → PR bridge (host-side), issue #1892 / Part 3 of the Stage 1
 * decomposition in spec/2026-07-20-autopilot-marketplace-execution.md
 * §"Delivery → PR bridge (host-side)".
 *
 * Consumes a delivered `jinn-repo.v1` solution envelope and turns it into a
 * reviewable draft PR: apply the patch in a fresh worktree off `origin/next`,
 * push the branch, open the draft PR with the `engine:review` label and the
 * on-chain evidence linked in the body. Solvers hold no GitHub credentials
 * (PR #1883 delegated-root boundary) — every GitHub write here runs as the
 * host identity via the injected `CommandRunner`.
 *
 * Two hard guards, independent of everything else:
 *   - `role !== 'solution'` is skipped (verdicts, captures — never bridged).
 *   - a task whose document is not `source: 'live-issue'` is REJECTED. A
 *     retrospective (`merged-pr`) envelope must never open a PR — those
 *     instances are mined from history, not live work.
 *
 * A patch that no longer applies to current `next` HEAD never silently
 * mutates: `git apply --check` gates `git apply`, and a failing check stalls
 * the task (label + one comment on the linked issue) instead of falling back
 * to `--3way` (a conflicting patch is stalled, not rebased).
 *
 * Idempotency is GitHub-derived, no local ledger: the branch name is
 * deterministic per (issue, task) — `feat/<issue_number>-<slug>-t<shortId>`
 * where `shortId` is the first 8 hex characters of the sha256 of the task's
 * IPFS CID (task CIDs are not themselves hex, so they are hashed down to a
 * short deterministic id). `gh pr list --head <branch> --state all` before
 * any work is the primary check; the hidden `<!-- jinn-task-cid: … -->`
 * marker in the PR body is defense-in-depth, not an active runtime check.
 *
 * This module is pure logic: transport (indexer GraphQL + IPFS gateway) is
 * hidden behind the injected `DeliveryReader` (see `./delivery-reader.js`
 * for the production implementation) and all `git`/`gh` calls go through the
 * injected `CommandRunner` — no module-scope side effects, mirrors
 * `drift-sweep.ts` / `merge-sweep.ts`.
 */

// ── Narrow wire-format schemas ──────────────────────────────────────────────
//
// Deliberately NOT importing `client/src/types/envelope.ts` or
// `@jinn-network/client` (autopilot must not depend on the client package —
// coordinator override of the original plan) and NOT depending on
// `@jinn-network/sdk` either: the envelope wire shape isn't exported by the
// SDK at all (only the task/payload schemas are), so a local schema is
// required regardless; duplicating the ~15-line task-shape alongside it to
// avoid a portal dependency (which would require building the SDK before
// every autopilot install/typecheck/test, with no existing CI wiring to
// automate that) is the simpler trade. These schemas cover ONLY what the
// bridge consumes — not the full `jinn.execution.v1` / `jinn-repo.v1` shapes.

/** The solverType this bridge acts on — the live variant of `jinn-repo`. */
export const MARKETPLACE_SOLVER_TYPE = 'jinn-repo.v1';

export const DEFAULT_REVIEW_LABEL = 'engine:review';
export const DEFAULT_STALL_LABEL = 'engine:stalled';

const BridgeTaskProvenanceSchema = z.object({
  cid: z.string().min(1),
  onchainCreationTx: z.string().optional(),
});

/** Narrow `jinn.execution.v1` envelope shape — only the fields the bridge reads. */
export const BridgeEnvelopeSchema = z.object({
  schemaVersion: z.literal('jinn.execution.v1'),
  solverType: z.string().min(1),
  // Accepts the legacy 'restoration' role alongside the canonical roles,
  // mirroring `client/src/types/envelope.ts`'s RawRoleSchema — jinn-repo.v1
  // is unlikely to ever emit the legacy role, but normalizing costs nothing.
  role: z.union([
    z.literal('solution'),
    z.literal('verdict'),
    z.literal('capture'),
    z.literal('restoration'),
  ]),
  generatedAt: z.number().int(),
  task: BridgeTaskProvenanceSchema,
  payload: z.record(z.unknown()),
});
export type BridgeEnvelope = z.infer<typeof BridgeEnvelopeSchema>;

/** `jinn-repo-solution.v1` payload — mirrors `packages/sdk/src/payloads/jinn-repo.ts`. */
const SolutionPayloadSchema = z.object({
  schemaVersion: z.literal('jinn-repo-solution.v1'),
  patch: z.string().min(1),
});

/**
 * Task-doc parse for the live-issue branch only — mirrors the live-issue half
 * of `packages/sdk/src/jinn-repo.ts` / `client/src/solver-types/jinn-repo.ts`.
 * A task doc that fails this parse (wrong `source`, or malformed) is the
 * retrospective-rejection guard: it is never narrowed to a live-issue task,
 * so `runDeliveryBridge` treats it as "reject, never open a PR" regardless of
 * *why* the parse failed. Not `.strict()` — tolerates the other live-issue
 * fields (`effort`, `problem_statement`, …) the bridge does not read.
 */
const LiveIssueTaskDocSchema = z.object({
  source: z.literal('live-issue'),
  repo: z.string().min(1),
  instance_id: z.string().min(1),
  issue_number: z.number().int().positive(),
});

// ── DeliveryReader seam ──────────────────────────────────────────────────────

/**
 * One delivered solution envelope, paired with the raw (unvalidated) task
 * document fetched from `envelope.task.cid`. The envelope is already parsed
 * against {@link BridgeEnvelopeSchema} (the reader needs `task.cid` to fetch
 * the task doc anyway); the task document is deliberately left raw — parsing
 * it against the live-issue-only schema is bridge POLICY (the retrospective
 * rejection guard), not transport.
 */
export interface DeliveredRecord {
  /** The envelope's own IPFS CID (the "manifest CID" elsewhere in the codebase). */
  manifestCid: string;
  envelope: BridgeEnvelope;
  taskRaw: unknown;
}

/**
 * Transport seam: hides how solution envelopes are discovered (indexer
 * GraphQL + IPFS gateway in production; a scripted fixture list in tests).
 * Implementations own their own "what's new since last time" cursor —
 * `runDeliveryBridge` never asks for or threads one through.
 */
export interface DeliveryReader {
  /** Poll for solution envelopes discovered since the reader's own cursor. */
  pollSolutions(): Promise<DeliveredRecord[]>;
}

// ── Bridge report + config ──────────────────────────────────────────────────

export interface DeliveryBridgeConfig {
  /** Fail-safe default false — mirrors `mergePrepEnabled` / `reviewBotLogin` gating. */
  enabled: boolean;
  /** Absolute path to the primary checkout `git -C` targets for `worktree add/remove`. */
  repoRoot: string;
  /** Directory new bridge worktrees are created under (sibling `jinn-mono_worktrees/`). */
  worktreesBase: string;
  /** IPFS gateway base URL for the evidence links in the PR body. */
  ipfsGatewayUrl: string;
  reviewLabel?: string;
  stallLabel?: string;
}

export interface DeliveryBridgeReport {
  opened: Array<{ issueNumber: number; prNumber: number | null; branch: string; manifestCid: string }>;
  stalled: Array<{ issueNumber: number; manifestCid: string; reason: string }>;
  /** Human-readable reasons for records deliberately not acted on. */
  skipped: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function errorDetail(err: unknown): string {
  if (err instanceof Error) {
    const stderr = (err as NodeJS.ErrnoException & { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr;
    return err.message;
  }
  return String(err);
}

/** Deterministic short id for the branch name — see module doc. */
function shortTaskId(taskCid: string): string {
  return createHash('sha256').update(taskCid).digest('hex').slice(0, 8);
}

const MAX_SLUG_LEN = 40;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/, '');
}

function branchName(issueNumber: number, instanceId: string, taskCid: string): string {
  const slug = slugify(instanceId) || 'task';
  return `feat/${issueNumber}-${slug}-t${shortTaskId(taskCid)}`;
}

function ipfsUrl(gatewayUrl: string, cid: string): string {
  return `${gatewayUrl.replace(/\/$/, '')}/ipfs/${cid}`;
}

/** Base Sepolia — the network Stage 1 runs on (spec §"Fleet permissioning"). */
function basescanTxUrl(txHash: string): string {
  return `https://sepolia.basescan.org/tx/${txHash}`;
}

function prBody(args: {
  issueNumber: number;
  manifestCid: string;
  taskCid: string;
  onchainCreationTx: string | undefined;
  ipfsGatewayUrl: string;
}): string {
  const lines = [
    `Closes #${args.issueNumber}`,
    '',
    'Auto-opened by the Autopilot delivery→PR bridge from a marketplace-delivered ' +
      'solution envelope (spec/2026-07-20-autopilot-marketplace-execution.md ' +
      '§"Delivery → PR bridge (host-side)"). The solver held no GitHub credentials; ' +
      'this push and PR use the host identity.',
    '',
    '## Evidence',
    `- Solution envelope: ${ipfsUrl(args.ipfsGatewayUrl, args.manifestCid)}`,
    `- Task: ${ipfsUrl(args.ipfsGatewayUrl, args.taskCid)}`,
  ];
  if (args.onchainCreationTx != null && args.onchainCreationTx !== '') {
    lines.push(`- Task creation tx: ${basescanTxUrl(args.onchainCreationTx)}`);
  }
  lines.push('', `<!-- jinn-task-cid: ${args.taskCid} -->`);
  return lines.join('\n');
}

function stallCommentBody(reason: string): string {
  return [
    'Auto-detected by the Autopilot delivery→PR bridge: the marketplace-delivered ' +
      'patch for this issue no longer applies to the current `next` HEAD.',
    '',
    '```',
    reason.trim().slice(0, 4000),
    '```',
    '',
    'The verified patch is never silently mutated (no `--3way` fallback) — this task ' +
      'needs a fresh re-post against the new head.',
  ].join('\n');
}

interface GhIssueLabelsView {
  labels?: Array<{ name?: string }>;
}

interface GhPrListEntry {
  number: number;
}

// ── Core ─────────────────────────────────────────────────────────────────────

async function processRecord(
  rec: DeliveredRecord,
  runner: CommandRunner,
  cfg: DeliveryBridgeConfig,
  report: DeliveryBridgeReport,
): Promise<void> {
  const { envelope, taskRaw, manifestCid } = rec;

  // Guard 1 (redundant with the reader's own filtering, kept independent —
  // mirrors `classifyStuck` staying independent of `classifyCandidate` in
  // merge-sweep.ts): only ever act on jinn-repo.v1.
  if (envelope.solverType !== MARKETPLACE_SOLVER_TYPE) {
    report.skipped.push(`${manifestCid}: solverType ${envelope.solverType} — not ${MARKETPLACE_SOLVER_TYPE}`);
    return;
  }

  // Guard 2: role filter. 'restoration' is the legacy name for 'solution'.
  if (envelope.role !== 'solution' && envelope.role !== 'restoration') {
    report.skipped.push(`${manifestCid}: role=${envelope.role} — not a solution`);
    return;
  }

  // Guard 3 (the hard guard): retrospective envelopes never open a PR. A task
  // doc that fails the live-issue parse — wrong `source`, or malformed — is
  // rejected, no exceptions and no partial credit for "almost live-issue".
  const taskParsed = LiveIssueTaskDocSchema.safeParse(taskRaw);
  if (!taskParsed.success) {
    report.skipped.push(`${manifestCid}: task doc is not a live-issue task — rejected (never opens a PR)`);
    return;
  }
  const task = taskParsed.data;

  const payloadParsed = SolutionPayloadSchema.safeParse(envelope.payload);
  if (!payloadParsed.success) {
    report.skipped.push(`${manifestCid}: solution payload invalid — ${payloadParsed.error.issues.map((i) => i.message).join('; ')}`);
    return;
  }
  const patch = payloadParsed.data.patch;

  const issueNumber = task.issue_number;
  const taskCid = envelope.task.cid;
  const branch = branchName(issueNumber, task.instance_id, taskCid);

  // Idempotency — GitHub-derived, no local ledger (see module doc).
  const existingRaw = await runner('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--head', branch,
    '--state', 'all',
    '--json', 'number',
  ]);
  const existing = JSON.parse(existingRaw || '[]') as GhPrListEntry[];
  if (existing.length > 0) {
    report.skipped.push(`#${issueNumber}: branch ${branch} already has PR #${existing[0]!.number} — idempotent skip`);
    return;
  }

  const shortId = shortTaskId(taskCid);
  const worktreePath = join(cfg.worktreesBase, `bridge-${issueNumber}-${shortId}`);

  // Fresh worktree off origin/next HEAD. Fetch first: this process's ambient
  // checkout has no periodic fetch loop of its own, and a stale local
  // `origin/next` ref would misclassify a genuinely-clean apply as a stall.
  await runner('git', ['-C', cfg.repoRoot, 'fetch', 'origin', 'next', '--quiet']);
  await runner('git', ['-C', cfg.repoRoot, 'worktree', 'add', worktreePath, '-b', branch, 'origin/next']);

  const patchFile = join(tmpdir(), `jinn-bridge-${issueNumber}-${shortId}.patch`);
  writeFileSync(patchFile, patch, 'utf8');

  try {
    try {
      await runner('git', ['-C', worktreePath, 'apply', '--check', patchFile]);
    } catch (err) {
      // Stall path: never fall back to --3way. A conflicting patch is
      // stalled, not rebased — the task needs a re-post against the new head.
      const reason = errorDetail(err);
      const stallLabel = cfg.stallLabel ?? DEFAULT_STALL_LABEL;
      const labelsRaw = await runner('gh', ['issue', 'view', String(issueNumber), '--repo', REPO, '--json', 'labels']);
      const labels = ((JSON.parse(labelsRaw || '{}') as GhIssueLabelsView).labels ?? [])
        .map((l) => l.name ?? '');
      if (!labels.includes(stallLabel)) {
        // Label first (the idempotency marker — mirrors stuck-escalation.ts):
        // a restart that re-sees this same envelope must not re-comment.
        await runner('gh', ['issue', 'edit', String(issueNumber), '--repo', REPO, '--add-label', stallLabel]);
        await runner('gh', [
          'issue', 'comment', String(issueNumber),
          '--repo', REPO,
          '--body', stallCommentBody(reason),
        ]);
      }
      await runner('git', ['-C', cfg.repoRoot, 'worktree', 'remove', '--force', worktreePath]);
      await runner('git', ['-C', cfg.repoRoot, 'branch', '-D', branch]);
      report.stalled.push({ issueNumber, manifestCid, reason });
      return;
    }

    await runner('git', ['-C', worktreePath, 'apply', patchFile]);
    await runner('git', ['-C', worktreePath, 'add', '-A']);
    await runner('git', [
      '-C', worktreePath,
      'commit', '-m',
      `feat: apply marketplace-delivered patch for #${issueNumber}\n\ntask-cid: ${taskCid}`,
    ]);
    await runner('git', ['-C', worktreePath, 'push', '-u', 'origin', branch]);

    const prOut = await runner('gh', [
      'pr', 'create',
      '--repo', REPO,
      '--draft',
      '--base', 'next',
      '--head', branch,
      '--label', cfg.reviewLabel ?? DEFAULT_REVIEW_LABEL,
      '--title', `feat: marketplace delivery for #${issueNumber}`,
      '--body', prBody({
        issueNumber,
        manifestCid,
        taskCid,
        onchainCreationTx: envelope.task.onchainCreationTx,
        ipfsGatewayUrl: cfg.ipfsGatewayUrl,
      }),
    ]);
    const m = /\/pull\/(\d+)/.exec(prOut);
    report.opened.push({ issueNumber, prNumber: m ? Number(m[1]) : null, branch, manifestCid });

    // Attempt-scoped cleanup (mirrors the other sweeps): the branch is now
    // pushed and PR'd, the local worktree checkout has done its job.
    await runner('git', ['-C', cfg.repoRoot, 'worktree', 'remove', '--force', worktreePath]);
  } finally {
    try {
      unlinkSync(patchFile);
    } catch {
      // best-effort cleanup of the scratch patch file
    }
  }
}

/**
 * Poll the `DeliveryReader` for new solution envelopes and turn each
 * qualifying one into a draft PR. Best-effort per record (a failure is
 * logged, never fatal) — mirrors `syncDrift` / `syncMerges`.
 */
export async function runDeliveryBridge(
  reader: DeliveryReader,
  runner: CommandRunner,
  cfg: DeliveryBridgeConfig,
): Promise<DeliveryBridgeReport> {
  const report: DeliveryBridgeReport = { opened: [], stalled: [], skipped: [] };
  if (!cfg.enabled) return report;

  let records: DeliveredRecord[];
  try {
    records = await reader.pollSolutions();
  } catch (err) {
    console.error('[delivery-pr-bridge] poll failed (skipping this cycle):', err);
    return report;
  }

  for (const rec of records) {
    try {
      await processRecord(rec, runner, cfg, report);
    } catch (err) {
      console.error(`[delivery-pr-bridge] processing failed for ${rec.manifestCid} (continuing):`, err);
      report.skipped.push(`${rec.manifestCid}: processing error — see log`);
    }
  }

  return report;
}
