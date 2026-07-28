import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import tasksCommand from '@/cli/commands/tasks.js';
import {
  emitIssueRelayObservationResult,
  parseIssueRelayDeliveryCommandResult,
} from '@/cli/commands/tasks-observe-issue-relay.js';
import { makeCommandCtx } from '@test/cli.js';

describe('tasks observe-issue-relay-delivery machine command', () => {
  it('emits exactly one strict JSON envelope and distinct pending and contradiction exits', () => {
    const pending = makeCommandCtx();
    emitIssueRelayObservationResult(pending.ctx, { status: 'pending', reason: 'attempt-not-indexed' });
    expect(pending.writes).toHaveLength(1);
    expect(JSON.parse(pending.writes[0]!)).toMatchObject({ verb: 'tasks observe-issue-relay-delivery', observation: { status: 'pending' } });
    expect(pending.exits).toEqual([30]);

    const contradiction = makeCommandCtx();
    emitIssueRelayObservationResult(contradiction.ctx, { status: 'contradiction', reason: 'task-mismatch', detail: 'wrong Task CID' });
    expect(contradiction.writes).toHaveLength(1);
    expect(contradiction.exits).toEqual([50]);
  });

  it('rejects non-machine, relative-path, and ambient-write invocations before config loading', async () => {
    for (const argv of [
      ['observe-issue-relay-delivery', '--expectation-file', 'relative.json', '--json'],
      ['observe-issue-relay-delivery', '--expectation-file', '/tmp/x.json'],
      ['observe-issue-relay-delivery', '--expectation-file', '/tmp/x.json', '--json', '--yes'],
      ['observe-issue-relay-delivery', '--expectation-file', '/tmp/x.json', '--json', '--dry-run'],
    ]) {
      const made = makeCommandCtx({ argv });
      await tasksCommand.run(made.ctx);
      expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({ code: 'invalid_invocation' });
      expect(made.exits).toEqual([11]);
    }
  });

  it('uses transient-error exit for operational failures and rejects unknown result fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-observe-relay-'));
    const expectation = join(dir, 'expectation.json');
    const config = join(dir, 'config.json');
    writeFileSync(expectation, JSON.stringify({
      schemaVersion: 'jinn-issue-relay-delivery-expectation.v1', role: 'solution',
      taskId: '501', taskCid: `f01551220${'3'.repeat(64)}`, creationBlockNumber: 100,
      round: {
        schemaVersion: 'jinn-issue-relay-round.v1', generation: 'relay:501', round: 0,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
        targetRepository: 'Jinn-Network/mono', workspaceRepository: 'Jinn-Network/mono',
        inputHead: '1'.repeat(40), purpose: 'initial', findings: [],
      },
    }));
    writeFileSync(config, '{ malformed');
    const made = makeCommandCtx({ argv: ['observe-issue-relay-delivery', '--expectation-file', expectation, '--config', config, '--json'] });
    await tasksCommand.run(made.ctx);
    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({ code: 'transient_error' });
    expect(made.exits).toEqual([40]);
    expect(() => parseIssueRelayDeliveryCommandResult({ schemaVersion: 1, generatedAt: '2026-07-28T00:00:00.000Z', verb: 'tasks observe-issue-relay-delivery', observation: { status: 'pending', reason: 'x' }, extra: true })).toThrow();
  });

  it('rejects malformed canonical Task CIDs before config or RPC initialization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-observe-relay-invalid-cid-'));
    const expectation = join(dir, 'expectation.json');
    const config = join(dir, 'config.json');
    writeFileSync(expectation, JSON.stringify({
      schemaVersion: 'jinn-issue-relay-delivery-expectation.v1', role: 'solution',
      taskId: '501', taskCid: `f01551220${'g'.repeat(64)}`, creationBlockNumber: 100,
      round: {
        schemaVersion: 'jinn-issue-relay-round.v1', generation: 'relay:501', round: 0,
        snapshotDigest: `sha256:${'a'.repeat(64)}`,
        targetRepository: 'Jinn-Network/mono', workspaceRepository: 'Jinn-Network/mono',
        inputHead: '1'.repeat(40), purpose: 'initial', findings: [],
      },
    }));
    writeFileSync(config, '{ malformed');
    const made = makeCommandCtx({ argv: ['observe-issue-relay-delivery', '--expectation-file', expectation, '--config', config, '--json'] });
    await tasksCommand.run(made.ctx);
    expect(JSON.parse(made.writes.at(-1)!)).toMatchObject({
      code: 'invalid_invocation', message: expect.stringMatching(/Task CID/i),
    });
    expect(made.exits).toEqual([11]);
  });

  it('rejects verified envelopes whose role and payload schema disagree', () => {
    const verified = {
      status: 'verified', role: 'verdict', task: { taskId: '501', taskCid: 'bafy-task' },
      attempt: { attemptIndex: 0, requestId: `0x${'1'.repeat(64)}`, operator: `0x${'2'.repeat(40)}` },
      delivery: { envelopeCid: 'bafy-envelope', transactionHash: `0x${'3'.repeat(64)}`, blockNumber: 120 },
      round: { schemaVersion: 'jinn-issue-relay-round.v1', generation: 'relay:501', round: 0, snapshotDigest: `sha256:${'a'.repeat(64)}`, targetRepository: 'Jinn-Network/mono', workspaceRepository: 'Jinn-Network/mono', inputHead: '1'.repeat(40), purpose: 'initial', findings: [] },
      payload: { schemaVersion: 'jinn-repo-solution.v1', patch: 'diff --git a/a b/a\n' },
    };
    expect(() => parseIssueRelayDeliveryCommandResult({ schemaVersion: 1, generatedAt: '2026-07-28T00:00:00.000Z', verb: 'tasks observe-issue-relay-delivery', observation: verified })).toThrow();
    expect(() => parseIssueRelayDeliveryCommandResult({ schemaVersion: 1, generatedAt: '2026-07-28T00:00:00.000Z', verb: 'tasks observe-issue-relay-delivery', observation: { ...verified, role: 'solution', payload: { schemaVersion: 'jinn-issue-relay-verdict.v1' } } })).toThrow();
  });
});
