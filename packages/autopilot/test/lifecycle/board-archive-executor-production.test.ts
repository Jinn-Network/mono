import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveBoardItems,
  BOARD_ARCHIVE_MAX_PER_SWEEP,
  boardArchiveMarkerPath,
  runBoardArchiveSweep,
  shouldRunBoardArchiveSweep,
} from '../../src/lifecycle/board-archive-executor-production.js';
import { CredentialPool, selectCredential } from '../../src/lifecycle/credentials.js';

const NOW = new Date('2026-07-20T12:00:00.000Z');

function credential() {
  const selection = selectCredential(new CredentialPool([{
    login: 'implementation-bot',
    normalizedLogin: 'implementation-bot',
    implementationToken: 'selected-secret',
  }]), { phase: 'implement' });
  if (selection.status !== 'selected') throw new Error('selection failed');
  return selection.credential;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratchMarkerPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'board-archive-test-'));
  roots.push(root);
  return boardArchiveMarkerPath(root);
}

describe('shouldRunBoardArchiveSweep', () => {
  it('runs when there is no prior marker', () => {
    expect(shouldRunBoardArchiveSweep(null, NOW)).toBe(true);
  });

  it('does not run again inside the cooldown window', () => {
    const marker = { lastRunAt: new Date(NOW.getTime() - 60_000).toISOString() };
    expect(shouldRunBoardArchiveSweep(marker, NOW)).toBe(false);
  });

  it('runs again once the cooldown has fully elapsed', () => {
    const marker = { lastRunAt: new Date(NOW.getTime() - 24 * 60 * 60_000).toISOString() };
    expect(shouldRunBoardArchiveSweep(marker, NOW)).toBe(true);
  });

  it('runs when the marker predates the cooldown boundary by one more millisecond', () => {
    const marker = { lastRunAt: new Date(NOW.getTime() - 24 * 60 * 60_000 - 1).toISOString() };
    expect(shouldRunBoardArchiveSweep(marker, NOW)).toBe(true);
  });

  it('honors a custom cooldown window', () => {
    const marker = { lastRunAt: new Date(NOW.getTime() - 5_000).toISOString() };
    expect(shouldRunBoardArchiveSweep(marker, NOW, 10_000)).toBe(false);
    expect(shouldRunBoardArchiveSweep(marker, NOW, 1_000)).toBe(true);
  });
});

describe('archiveBoardItems', () => {
  function fakeRunner(calls: Array<{ command: string; args: readonly string[] }>) {
    return async (command: string, args: readonly string[]): Promise<string> => {
      calls.push({ command, args });
      return JSON.stringify({ data: {} });
    };
  }

  it('batches archive mutations at 20 items per request', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const itemIds = Array.from({ length: 45 }, (_, index) => `ITEM_${index}`);
    const result = await archiveBoardItems(itemIds, {
      credential: credential(),
      runner: fakeRunner(calls),
      environment: {},
      projectId: 'PVT_test',
    });
    expect(result).toEqual({ archived: 45, capped: false });
    // 45 items / 20 per batch = 3 requests (20, 20, 5).
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.command).toBe('gh');
      expect(call.args).toEqual(['api', 'graphql', '-f', expect.stringContaining('query=mutation {')]);
    }
    const firstQuery = calls[0]!.args[3]!;
    expect(firstQuery).toContain('a0: archiveProjectV2Item(input: { projectId: "PVT_test", itemId: "ITEM_0" })');
    expect(firstQuery).toContain('a19: archiveProjectV2Item(input: { projectId: "PVT_test", itemId: "ITEM_19" })');
    expect(firstQuery).not.toContain('a20:');
    const thirdQuery = calls[2]!.args[3]!;
    expect(thirdQuery).toContain('a0: archiveProjectV2Item(input: { projectId: "PVT_test", itemId: "ITEM_40" })');
    expect(thirdQuery).toContain('a4: archiveProjectV2Item(input: { projectId: "PVT_test", itemId: "ITEM_44" })');
  });

  it('caps archiving at BOARD_ARCHIVE_MAX_PER_SWEEP and reports capped', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const itemIds = Array.from({ length: BOARD_ARCHIVE_MAX_PER_SWEEP + 10 }, (_, index) => `ITEM_${index}`);
    const result = await archiveBoardItems(itemIds, {
      credential: credential(),
      runner: fakeRunner(calls),
      environment: {},
      projectId: 'PVT_test',
    });
    expect(result).toEqual({ archived: BOARD_ARCHIVE_MAX_PER_SWEEP, capped: true });
    const archivedItemIds = calls.flatMap((call) => {
      const matches = call.args[3]!.matchAll(/itemId: "(ITEM_\d+)"/g);
      return [...matches].map((match) => match[1]);
    });
    expect(archivedItemIds).toHaveLength(BOARD_ARCHIVE_MAX_PER_SWEEP);
    expect(archivedItemIds).not.toContain(`ITEM_${BOARD_ARCHIVE_MAX_PER_SWEEP}`);
  });

  it('reports uncapped when exactly at the cap', async () => {
    const itemIds = Array.from({ length: BOARD_ARCHIVE_MAX_PER_SWEEP }, (_, index) => `ITEM_${index}`);
    const result = await archiveBoardItems(itemIds, {
      credential: credential(),
      runner: async () => JSON.stringify({ data: {} }),
      environment: {},
    });
    expect(result).toEqual({ archived: BOARD_ARCHIVE_MAX_PER_SWEEP, capped: false });
  });

  it('makes no request for an empty candidate list', async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = await archiveBoardItems([], {
      credential: credential(),
      runner: fakeRunner(calls),
      environment: {},
    });
    expect(result).toEqual({ archived: 0, capped: false });
    expect(calls).toHaveLength(0);
  });
});

describe('runBoardArchiveSweep', () => {
  const doneSnapshot = {
    items: [{ id: 'ITEM_1', status: 'Done' as const, sprintIterationId: null }],
    currentSprintIterationId: 'iter-current',
  };

  it('archives on a fresh host with no prior marker, then throttles the very next run', async () => {
    const markerPath = scratchMarkerPath();
    const calls: string[] = [];
    const runner = async (_command: string, args: readonly string[]): Promise<string> => {
      calls.push(args.join(' '));
      return JSON.stringify({ data: {} });
    };

    const first = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: NOW,
      credential: credential(),
      runner,
      environment: {},
      projectId: 'PVT_test',
      markerPath,
    });
    expect(first).toEqual({ status: 'archived', archived: 1, capped: false });
    expect(calls).toHaveLength(1);

    const second = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: new Date(NOW.getTime() + 60_000),
      credential: credential(),
      runner,
      environment: {},
      projectId: 'PVT_test',
      markerPath,
    });
    expect(second).toEqual({ status: 'skipped-throttled' });
    // No additional GraphQL calls were made on the throttled run.
    expect(calls).toHaveLength(1);
  });

  it('runs again once 24h have elapsed since the marker', async () => {
    const markerPath = scratchMarkerPath();
    const calls: string[] = [];
    const runner = async (_command: string, args: readonly string[]): Promise<string> => {
      calls.push(args.join(' '));
      return JSON.stringify({ data: {} });
    };

    await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: NOW,
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(calls).toHaveLength(1);

    const oneDayLater = new Date(NOW.getTime() + 24 * 60 * 60_000);
    const result = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: oneDayLater,
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(result).toEqual({ status: 'archived', archived: 1, capped: false });
    expect(calls).toHaveLength(2);
  });

  it('does not propagate a sweep failure — it resolves with status "failed"', async () => {
    const markerPath = scratchMarkerPath();
    const runner = async (): Promise<string> => {
      throw new Error('gh api graphql exploded');
    };

    await expect(runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: NOW,
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    })).resolves.toEqual({ status: 'failed', reason: 'gh api graphql exploded' });
  });

  it('does not consume the throttle window on failure, so the next cycle retries', async () => {
    const markerPath = scratchMarkerPath();
    let attempt = 0;
    const runner = async (): Promise<string> => {
      attempt += 1;
      if (attempt === 1) throw new Error('transient failure');
      return JSON.stringify({ data: {} });
    };

    const first = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: NOW,
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(first.status).toBe('failed');

    // Immediately retrying (no 24h elapsed) still runs, because the failed
    // attempt never wrote the marker.
    const second = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: new Date(NOW.getTime() + 1_000),
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(second).toEqual({ status: 'archived', archived: 1, capped: false });
  });

  it('reports zero archived (and still throttles) when there is nothing to archive', async () => {
    const markerPath = scratchMarkerPath();
    const calls: string[] = [];
    const runner = async (_command: string, args: readonly string[]): Promise<string> => {
      calls.push(args.join(' '));
      return JSON.stringify({ data: {} });
    };
    const emptySnapshot = {
      items: [{ id: 'ITEM_1', status: 'Todo' as const, sprintIterationId: null }],
      currentSprintIterationId: 'iter-current',
    };

    const result = await runBoardArchiveSweep({
      snapshot: emptySnapshot,
      now: NOW,
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(result).toEqual({ status: 'archived', archived: 0, capped: false });
    // No archive candidates: no GraphQL mutation call was needed.
    expect(calls).toHaveLength(0);

    const throttled = await runBoardArchiveSweep({
      snapshot: emptySnapshot,
      now: new Date(NOW.getTime() + 1_000),
      credential: credential(),
      runner,
      environment: {},
      markerPath,
    });
    expect(throttled).toEqual({ status: 'skipped-throttled' });
  });

  it('treats a corrupt marker file as "never run" rather than failing', async () => {
    const markerPath = scratchMarkerPath();
    writeFileSync(markerPath, 'not json', { encoding: 'utf8' });
    const result = await runBoardArchiveSweep({
      snapshot: doneSnapshot,
      now: NOW,
      credential: credential(),
      runner: async () => JSON.stringify({ data: {} }),
      environment: {},
      markerPath,
    });
    expect(result).toEqual({ status: 'archived', archived: 1, capped: false });
    const written = JSON.parse(readFileSync(markerPath, 'utf8')) as { lastRunAt: string };
    expect(written.lastRunAt).toBe(NOW.toISOString());
  });
});
