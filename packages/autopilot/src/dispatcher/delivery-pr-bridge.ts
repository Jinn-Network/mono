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
 * Three hard guards, independent of everything else:
 *   - `role !== 'solution'` is skipped (verdicts, captures — never bridged).
 *   - a task whose document is not `source: 'live-issue'` is REJECTED. A
 *     retrospective (`merged-pr`) envelope must never open a PR — those
 *     instances are mined from history, not live work.
 *   - the claimed `issue_number` must resolve to an OPEN issue (not a pull
 *     request) before any GitHub side effect; this narrows but does NOT
 *     fully close the `issue_number` provenance gap (nothing yet proves the
 *     task was posted by an issue *we* opened — full binding awaits the
 *     generator ledger from #1893's Part 4).
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

// Conservative CID/tx-hash shape guards (fix for issue #1892 finding 1a).
// `cid` / `onchainCreationTx` used to accept ANY non-empty string and were
// interpolated raw into GitHub-facing text (PR body, commit message) — a
// squash-merge concatenates commit messages into the merge-commit body, so
// an attacker-chosen value could smuggle a `Closes #N` line or an `@mention`
// into merged history. Restricting the charset is the PRIMARY defense (it
// makes CR/LF, `@`, `#`, and backticks structurally impossible in a value
// that parses), not just an afterthought — `sanitizeForGitHubText` below is
// the defense-in-depth layer applied regardless of whether a field is
// already schema-constrained.
//
// CIDv0: bare base58btc, always "Qm" + 44 chars (sha2-256 multihash).
// Mirrors `packages/indexer/src/ipfs.ts`'s `CID_V0_RE`.
const CID_V0_RE = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
// CIDv1: multibase 'b' prefix + lowercase RFC4648 base32 (no padding).
// Deliberately lowercase-only and length-bounded — tighter than the
// indexer's `CID_V1_SAFE_RE` (which allows mixed case and `-`) because this
// value flows into a git commit message and PR body, not just a gateway URL.
const CID_V1_BASE32_RE = /^b[a-z2-7]{20,119}$/;
const CID_PATTERN = new RegExp(`(?:${CID_V0_RE.source}|${CID_V1_BASE32_RE.source})`);

/** A real tx hash is always exactly `0x` + 64 hex chars — nothing else parses. */
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const BridgeTaskProvenanceSchema = z.object({
  cid: z.string().regex(CID_PATTERN, 'not a recognized CID shape (CIDv0 base58 or CIDv1 lowercase base32)'),
  onchainCreationTx: z.string().regex(TX_HASH_PATTERN, 'not a 32-byte hex tx hash (0x + 64 hex chars)').optional(),
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

/**
 * Defense-in-depth for every untrusted (marketplace-derived) string
 * interpolated into GitHub-facing text — PR body, commit message, comment
 * body, or label (fix for issue #1892 finding 1b). Applied even to fields
 * already constrained by a strict schema upstream (e.g. `cid` / `tx hash` —
 * see `CID_PATTERN` / `TX_HASH_PATTERN` above): schemas can have bugs or get
 * loosened later, so this is a second, independent layer, not a substitute.
 * Mirrors the PR-title sanitization in `merge-prep-dispatch.ts`
 * (`s.title.replace(/[\r\n]+/g, ' ').trim()`) — strips CR/LF so a value can
 * never inject a line a reviewer or GitHub's keyword parser would read as
 * its own (a bare `Closes #N`, an `@mention`), and caps length so one field
 * cannot balloon the rendered surface.
 */
function sanitizeForGitHubText(value: string, maxLen = 4000): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
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
  // Defense-in-depth (finding 1b): sanitize every marketplace-derived string
  // even though `taskCid` / `onchainCreationTx` are already schema-validated
  // and `manifestCid` is not (it's the reader's indexer-row CID, never
  // parsed against `BridgeTaskProvenanceSchema`) — see `sanitizeForGitHubText`.
  const manifestCid = sanitizeForGitHubText(args.manifestCid);
  const taskCid = sanitizeForGitHubText(args.taskCid);
  const lines = [
    `Closes #${args.issueNumber}`,
    '',
    'Auto-opened by the Autopilot delivery→PR bridge from a marketplace-delivered ' +
      'solution envelope (spec/2026-07-20-autopilot-marketplace-execution.md ' +
      '§"Delivery → PR bridge (host-side)"). The solver held no GitHub credentials; ' +
      'this push and PR use the host identity.',
    '',
    '## Evidence',
    `- Solution envelope: ${ipfsUrl(args.ipfsGatewayUrl, manifestCid)}`,
    `- Task: ${ipfsUrl(args.ipfsGatewayUrl, taskCid)}`,
  ];
  if (args.onchainCreationTx != null && args.onchainCreationTx !== '') {
    lines.push(`- Task creation tx: ${basescanTxUrl(sanitizeForGitHubText(args.onchainCreationTx))}`);
  }
  lines.push('', `<!-- jinn-task-cid: ${taskCid} -->`);
  return lines.join('\n');
}

function stallCommentBody(reason: string): string {
  return [
    'Auto-detected by the Autopilot delivery→PR bridge: the marketplace-delivered ' +
      'patch for this issue no longer applies to the current `next` HEAD.',
    '',
    '```',
    // `reason` is derived from `git apply --check`'s stderr against an
    // attacker-supplied patch — the patch's file-path headers are
    // attacker-chosen text that git echoes back verbatim, so this is
    // untrusted too (finding 1b): sanitized like every other GitHub-facing
    // interpolation, even inside a fenced code block (GitHub's closing-
    // keyword scan is not fence-aware).
    sanitizeForGitHubText(reason),
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

/** Shape of `gh api repos/<repo>/issues/<n>` this bridge reads (Guard 4). */
interface GhIssueApiView {
  state?: string;
  /**
   * GitHub's REST Issues endpoint returns pull requests too; this key is
   * only ever present (non-null) when the number actually resolves to a PR —
   * see the Guard 4 comment below for why this, and not `gh issue view`, is
   * the check.
   */
  pull_request?: unknown;
}

/**
 * Best-effort remove of the worktree checkout + local branch ref at one
 * deterministic (issue, task) path/name (fix for issue #1892 finding 2).
 * Called BOTH before `worktree add` (clears anything leaked by an earlier
 * run that threw before its own cleanup ran) and unconditionally from
 * `processRecord`'s `finally` (see there). Every failure is swallowed and
 * logged, never thrown: cleanup must never mask the real error a caller may
 * already be unwinding from, and a failed best-effort removal here just
 * means the next run's pre-add cleanup gets another attempt.
 */
async function bestEffortCleanupWorktree(
  runner: CommandRunner,
  repoRoot: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  try {
    await runner('git', ['-C', repoRoot, 'worktree', 'remove', '--force', worktreePath]);
  } catch (err) {
    console.error(`[delivery-pr-bridge] worktree remove failed for ${worktreePath} (continuing):`, err);
  }
  try {
    await runner('git', ['-C', repoRoot, 'branch', '-D', branch]);
  } catch (err) {
    console.error(`[delivery-pr-bridge] branch -D failed for ${branch} (continuing):`, err);
  }
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

  // Guard 4 (issue_number provenance — fix for issue #1892 finding 1c, NOT
  // fully closed here): `task.issue_number` comes from an untrusted task
  // document with nothing yet proving it was posted by an issue *we*
  // actually opened for this instance_id — that full binding needs the
  // generator ledger from #1893's Part 4 and does not exist yet. What IS
  // enforceable today, and required before any GitHub side effect below:
  // the claimed issue must exist, be OPEN, and be a genuine issue rather
  // than a pull request. `gh issue view` does NOT gate this — this repo has
  // hit `gh issue view` rendering a PR's page without erroring before (see
  // the "verify object type before closing" lesson) — so this uses the REST
  // `issues/<n>` endpoint directly: it returns pull requests too, but only a
  // PR response carries a `pull_request` key, which is the one reliable
  // discriminator. Any failure here is fail-closed: skip, log why, no PR.
  let issueView: GhIssueApiView;
  try {
    const issueRaw = await runner('gh', ['api', `repos/${REPO}/issues/${issueNumber}`]);
    issueView = JSON.parse(issueRaw) as GhIssueApiView;
  } catch (err) {
    report.skipped.push(`#${issueNumber}: issue provenance check failed (${errorDetail(err)}) — skipped, fail closed`);
    return;
  }
  if (issueView.state !== 'open') {
    report.skipped.push(`#${issueNumber}: issue is not OPEN (state=${issueView.state ?? 'unknown'}) — skipped, fail closed`);
    return;
  }
  if (issueView.pull_request != null) {
    report.skipped.push(`#${issueNumber}: number resolves to a pull request, not an issue — skipped, fail closed`);
    return;
  }

  const shortId = shortTaskId(taskCid);
  const worktreePath = join(cfg.worktreesBase, `bridge-${issueNumber}-${shortId}`);

  // Fresh worktree off origin/next HEAD. Fetch first: this process's ambient
  // checkout has no periodic fetch loop of its own, and a stale local
  // `origin/next` ref would misclassify a genuinely-clean apply as a stall.
  await runner('git', ['-C', cfg.repoRoot, 'fetch', 'origin', 'next', '--quiet']);

  // Resilience against a leaked worktree/branch pair from an OLDER run that
  // threw before its own cleanup could execute (fix for issue #1892 finding
  // 2): best-effort clear the deterministic path/branch before creating a
  // fresh one. `git worktree add --force` alone would NOT fix this — that
  // flag only overrides the "branch already checked out elsewhere" safety
  // check, not "this path is already a worktree" or "this branch name
  // already exists" (`-b` requires a genuinely new name); a direct
  // best-effort removal targets the actual leak shape instead.
  await bestEffortCleanupWorktree(runner, cfg.repoRoot, worktreePath, branch);
  await runner('git', ['-C', cfg.repoRoot, 'worktree', 'add', worktreePath, '-b', branch, 'origin/next']);

  const patchFile = join(tmpdir(), `jinn-bridge-${issueNumber}-${shortId}.patch`);
  writeFileSync(patchFile, patch, 'utf8');

  // The entire git-mutation span (worktree add through completion) is
  // exception-safe (fix for issue #1892 finding 2): ANY throw in here — a
  // scripted stall, a `gh` API error, a git push rejection, malformed `gh`
  // JSON — reaches the `finally` below, which unconditionally best-effort
  // cleans up the worktree + local branch. Deleting the LOCAL branch ref
  // after a successful push is safe: the remote copy (already pushed, and
  // what the just-opened PR points at) is untouched by `branch -D`.
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
      report.stalled.push({ issueNumber, manifestCid, reason });
      return; // worktree/branch cleanup happens in the `finally` below
    }

    await runner('git', ['-C', worktreePath, 'apply', patchFile]);
    await runner('git', ['-C', worktreePath, 'add', '-A']);
    await runner('git', [
      '-C', worktreePath,
      'commit', '-m',
      `feat: apply marketplace-delivered patch for #${issueNumber}\n\ntask-cid: ${sanitizeForGitHubText(taskCid)}`,
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
  } finally {
    try {
      unlinkSync(patchFile);
    } catch {
      // best-effort cleanup of the scratch patch file
    }
    await bestEffortCleanupWorktree(runner, cfg.repoRoot, worktreePath, branch);
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
