#!/usr/bin/env tsx
/**
 * Scheduled board painter (Stage 3) — no AI.
 *
 * Derives Project Status from git/PR/label facts, paints only on diff,
 * archives stale Done items, and closes orphan children whose parent
 * PR merged or closed. Spec §3:
 * `docs/superpowers/specs/2026-07-21-single-surface-lifecycle.md`.
 *
 * Org Projects v2 writes require a PAT / App token with `project` scope;
 * the default `GITHUB_TOKEN` cannot mutate org boards. Prefer
 * `JINN_AUTOPILOT_PAINTER_TOKEN`, fall back to `JINN_IMPL_GH_TOKEN`.
 */

import {
  defaultRunner,
  type CommandRunner,
} from '../src/dispatcher/issue-source.js';
import { ORG, PROJECT_NUMBER, REPO } from '../src/dispatcher/constants.js';
import {
  ensureFieldIds,
  PROJECT_ID,
} from '../src/dispatcher/field-cache.js';
import { fetchProjectSnapshot } from '../src/dispatcher/project-snapshot.js';
import {
  BOARD_ARCHIVE_BATCH_SIZE,
  BOARD_ARCHIVE_MAX_PER_SWEEP,
} from '../src/lifecycle/board-archive-executor-production.js';
import {
  planBoardPaint,
  type OrphanChildFact,
  type PaintBoardItem,
  type PaintFacts,
} from '../src/lifecycle/board-painter.js';
import { parseChildMarker } from '../src/lifecycle/child-issues.js';

interface OpenPrRow {
  readonly number: number;
  readonly isDraft: boolean;
  readonly labels: readonly { readonly name: string }[];
  readonly closingIssuesReferences: readonly { readonly number: number }[];
}

interface IssueRow {
  readonly number: number;
  readonly state: 'OPEN' | 'CLOSED';
  readonly labels: readonly { readonly name: string }[];
}

function painterToken(env: NodeJS.ProcessEnv): string | undefined {
  const painter = env.JINN_AUTOPILOT_PAINTER_TOKEN?.trim();
  if (painter) return painter;
  const impl = env.JINN_IMPL_GH_TOKEN?.trim();
  if (impl) return impl;
  const gh = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  return gh || undefined;
}

function withToken(
  run: CommandRunner,
  token: string | undefined,
): CommandRunner {
  if (token === undefined) return run;
  return (cmd, args, opts) => run(cmd, args, {
    ...opts,
    env: { ...process.env, ...opts?.env, GH_TOKEN: token, GITHUB_TOKEN: token },
  });
}

async function listOpenPullRequests(run: CommandRunner): Promise<OpenPrRow[]> {
  const raw = await run('gh', [
    'pr', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--limit', '500',
    '--json', 'number,isDraft,labels,closingIssuesReferences',
  ]);
  return JSON.parse(raw) as OpenPrRow[];
}

async function listClaimBranchIssueNumbers(
  run: CommandRunner,
): Promise<ReadonlySet<number>> {
  const raw = await run('gh', [
    'api',
    `repos/${REPO}/git/matching-refs/heads/autopilot/`,
    '--paginate',
    '--slurp',
  ]);
  const parsed = JSON.parse(raw) as unknown;
  const pages = Array.isArray(parsed) ? parsed : [];
  const refs = pages.flatMap((page) => (Array.isArray(page) ? page : [])) as Array<{
    ref?: string;
  }>;
  const numbers = new Set<number>();
  for (const ref of refs) {
    const match = /^refs\/heads\/autopilot\/([1-9][0-9]*)$/.exec(ref.ref ?? '');
    if (match === null) continue;
    numbers.add(Number(match[1]));
  }
  return numbers;
}

async function listOpenChildIssues(
  run: CommandRunner,
): Promise<readonly { number: number; body: string }[]> {
  const raw = await run('gh', [
    'issue', 'list',
    '--repo', REPO,
    '--state', 'open',
    '--limit', '500',
    '--search', 'jinn-autopilot:child in:body',
    '--json', 'number,body',
  ]);
  return JSON.parse(raw) as Array<{ number: number; body: string }>;
}

async function fetchIssueRows(
  run: CommandRunner,
  issueNumbers: readonly number[],
): Promise<Map<number, IssueRow>> {
  const out = new Map<number, IssueRow>();
  const unique = [...new Set(issueNumbers)].sort((a, b) => a - b);
  const chunkSize = 40;
  for (let offset = 0; offset < unique.length; offset += chunkSize) {
    const chunk = unique.slice(offset, offset + chunkSize);
    const fields = chunk.map((n, i) => (
      `  i${i}: issue(number: ${n}) {\n`
      + '    number\n'
      + '    state\n'
      + '    labels(first: 40) { nodes { name } }\n'
      + '  }'
    )).join('\n');
    const query = (
      `query {\n`
      + `  repository(owner: "${ORG}", name: "mono") {\n`
      + `${fields}\n`
      + '  }\n'
      + '}'
    );
    const raw = await run('gh', ['api', 'graphql', '-f', `query=${query}`]);
    const response = JSON.parse(raw) as {
      data?: { repository?: Record<string, {
        number: number;
        state: 'OPEN' | 'CLOSED';
        labels: { nodes: Array<{ name: string }> };
      } | null> };
    };
    const repo = response.data?.repository ?? {};
    for (const node of Object.values(repo)) {
      if (node === null || node === undefined) continue;
      out.set(node.number, {
        number: node.number,
        state: node.state,
        labels: node.labels.nodes,
      });
    }
  }
  return out;
}

async function fetchParentPrStates(
  run: CommandRunner,
  prNumbers: readonly number[],
): Promise<Map<number, 'open' | 'closed' | 'merged'>> {
  const out = new Map<number, 'open' | 'closed' | 'merged'>();
  for (const n of [...new Set(prNumbers)]) {
    const raw = await run('gh', [
      'pr', 'view', String(n),
      '--repo', REPO,
      '--json', 'state,mergedAt',
    ]);
    const pr = JSON.parse(raw) as { state: string; mergedAt: string | null };
    if (pr.mergedAt !== null) {
      out.set(n, 'merged');
    } else if (pr.state === 'OPEN') {
      out.set(n, 'open');
    } else {
      out.set(n, 'closed');
    }
  }
  return out;
}

function archiveMutation(projectId: string, itemIds: readonly string[]): string {
  const fields = itemIds
    .map((itemId, index) => (
      `  a${index}: archiveProjectV2Item(input: { projectId: "${projectId}", itemId: "${itemId}" }) {\n`
      + '    item { id }\n'
      + '  }'
    ))
    .join('\n');
  return `mutation {\n${fields}\n}`;
}

export interface PaintBoardRunResult {
  readonly paintsApplied: number;
  readonly paintsNoop: number;
  readonly archived: number;
  readonly orphanClosed: number;
}

export async function runPaintBoard(
  run: CommandRunner = defaultRunner,
  now: Date = new Date(),
): Promise<PaintBoardRunResult> {
  const snapshot = await fetchProjectSnapshot(run);
  const boardIssues = snapshot.items.filter((item) => item.contentType === 'Issue');
  const issueNumbers = boardIssues.map((item) => item.number);

  const [openPrs, claimIssues, childIssues, issueRows] = await Promise.all([
    listOpenPullRequests(run),
    listClaimBranchIssueNumbers(run),
    listOpenChildIssues(run),
    fetchIssueRows(run, issueNumbers),
  ]);

  const openPrByIssue = new Map<number, OpenPrRow>();
  const issueByOpenPr = new Map<number, number>();
  for (const pr of openPrs) {
    for (const issue of pr.closingIssuesReferences) {
      openPrByIssue.set(issue.number, pr);
      issueByOpenPr.set(pr.number, issue.number);
    }
  }

  const parentPrsFromChildren: number[] = [];
  const parsedChildren: Array<{ childNumber: number; parentPr: number }> = [];
  for (const child of childIssues) {
    const marker = parseChildMarker(child.body ?? '');
    if (marker === null) continue;
    parsedChildren.push({ childNumber: child.number, parentPr: marker.parentPr });
    parentPrsFromChildren.push(marker.parentPr);
  }

  const issuesWithOpenChildren = new Set<number>();
  for (const child of parsedChildren) {
    const parentIssue = issueByOpenPr.get(child.parentPr);
    if (parentIssue !== undefined) issuesWithOpenChildren.add(parentIssue);
  }

  const paintItems: PaintBoardItem[] = boardIssues.map((boardItem) => {
    const issue = issueRows.get(boardItem.number);
    const openPr = openPrByIssue.get(boardItem.number);
    const labelNames = [
      ...(issue?.labels.map((l) => l.name) ?? []),
      ...(openPr?.labels.map((l) => l.name) ?? []),
    ];
    const paintFacts: PaintFacts = {
      issueOpen: issue === undefined ? true : issue.state === 'OPEN',
      labels: labelNames,
      hasOpenDraftPr: openPr?.isDraft === true,
      hasOpenNonDraftPr: openPr !== undefined && openPr.isDraft === false,
      hasClaimBranch: claimIssues.has(boardItem.number),
      merged: issue !== undefined && issue.state === 'CLOSED' && openPr === undefined,
      hasOpenChildren: issuesWithOpenChildren.has(boardItem.number),
    };
    return {
      itemId: boardItem.id,
      issueNumber: boardItem.number,
      currentStatus: boardItem.status,
      facts: paintFacts,
      sprintIterationId: boardItem.sprintIterationId,
    };
  });

  const parentStates = await fetchParentPrStates(run, parentPrsFromChildren);
  const orphanChildren: OrphanChildFact[] = parsedChildren.map((child) => ({
    childIssueNumber: child.childNumber,
    parentPrNumber: child.parentPr,
    parentState: parentStates.get(child.parentPr) ?? 'open',
  }));

  const plan = planBoardPaint(
    paintItems,
    orphanChildren,
    snapshot.currentSprintIterationId,
    now,
  );

  const fields = await ensureFieldIds(run);
  let paintsApplied = 0;
  for (const paint of plan.paints) {
    await run('gh', [
      'project', 'item-edit',
      '--id', paint.itemId,
      '--project-id', fields.projectId,
      '--field-id', fields.status.fieldId,
      '--single-select-option-id', fields.status.options[paint.to],
    ]);
    console.log(
      `[paint-board] paint #${paint.issueNumber} ${paint.from ?? 'null'} → ${paint.to}`,
    );
    paintsApplied += 1;
  }
  const paintsNoop = paintItems.length - paintsApplied;
  if (paintsApplied === 0) {
    console.log(`[paint-board] status no-op (${paintsNoop} items already match)`);
  } else {
    console.log(`[paint-board] status painted=${paintsApplied} no-op=${paintsNoop}`);
  }

  const toArchive = plan.archiveItemIds.slice(0, BOARD_ARCHIVE_MAX_PER_SWEEP);
  let archived = 0;
  for (let offset = 0; offset < toArchive.length; offset += BOARD_ARCHIVE_BATCH_SIZE) {
    const batch = toArchive.slice(offset, offset + BOARD_ARCHIVE_BATCH_SIZE);
    await run('gh', [
      'api', 'graphql', '-f', `query=${archiveMutation(PROJECT_ID, batch)}`,
    ]);
    archived += batch.length;
  }
  if (archived > 0) {
    console.log(`[paint-board] archived ${archived} Done item(s)`);
  } else {
    console.log('[paint-board] archive no-op');
  }

  let orphanClosed = 0;
  for (const close of plan.orphanCloses) {
    await run('gh', [
      'issue', 'close', String(close.childIssueNumber),
      '--repo', REPO,
      '--comment', `Autopilot painter: ${close.reason}; closing orphan child.`,
    ]);
    console.log(
      `[paint-board] orphan-close #${close.childIssueNumber} (${close.reason})`,
    );
    orphanClosed += 1;
  }
  if (orphanClosed === 0) {
    console.log('[paint-board] orphan-close no-op');
  }

  console.log(
    `[paint-board] done project=${PROJECT_NUMBER} paints=${paintsApplied} `
    + `archived=${archived} orphanClosed=${orphanClosed}`,
  );
  return { paintsApplied, paintsNoop, archived, orphanClosed };
}

async function main(): Promise<void> {
  const token = painterToken(process.env);
  if (token === undefined) {
    console.warn(
      '[paint-board] warning: no JINN_AUTOPILOT_PAINTER_TOKEN / '
      + 'JINN_IMPL_GH_TOKEN / GH_TOKEN; org Project writes will fail',
    );
  }
  const run = withToken(defaultRunner, token);
  await runPaintBoard(run);
}

const isDirect = process.argv[1]?.endsWith('paint-board.ts') === true
  || process.argv[1]?.endsWith('paint-board.js') === true;
if (isDirect) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
