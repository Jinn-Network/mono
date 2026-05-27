import { describe, it, expect } from 'vitest';
import { runTriageCheck } from '../../src/triage/cli.js';
import type { CommandRunner } from '../../src/dispatcher/issue-source.js';

/**
 * Tests for the thin CLI wrapper around the gather + classify pipeline.
 *
 * runTriageCheck(issueNumber, runner, write) writes one JSON line with the
 * verdict to `write` (stdout in production). It rethrows on any
 * gather/classify failure (fail-loud).
 */

function captureWriter(): { written: string[]; write: (s: string) => void } {
  const written: string[] = [];
  return {
    written,
    write: (s) => {
      written.push(s);
    },
  };
}

describe('runTriageCheck', () => {
  it('prints a JSON verdict for a clear case', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return '';
      if (cmd === 'gh' && args[0] === 'search') return '[]';
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({ closedByPullRequestsReferences: [] });
      }
      if (cmd === 'git' && args[0] === 'log') return '';
      throw new Error(`unhandled: ${cmd} ${args.join(' ')}`);
    };

    const cap = captureWriter();
    await runTriageCheck(572, runner, cap.write);

    expect(cap.written.length).toBeGreaterThan(0);
    const joined = cap.written.join('');
    const parsed = JSON.parse(joined.trim()) as {
      classification: string;
      evidence: unknown;
      suggestedBlockedOn: string | null;
      suggestedComment: string | null;
    };

    expect(parsed.classification).toBe('clear');
    expect(parsed.suggestedBlockedOn).toBeNull();
    expect(parsed.suggestedComment).toBeNull();
  });

  it('rethrows when the gatherer fails', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return '';
      if (cmd === 'gh' && args[0] === 'search') {
        throw new Error('gh: HTTP 500');
      }
      throw new Error(`unhandled: ${cmd} ${args.join(' ')}`);
    };

    const cap = captureWriter();
    await expect(runTriageCheck(572, runner, cap.write)).rejects.toThrow(
      /HTTP 500/,
    );
    // Nothing written when gather failed
    expect(cap.written.join('')).toBe('');
  });

  it('prints fixed-pending-backmerge for the AC #4 scenario', async () => {
    const runner: CommandRunner = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return '';
      if (cmd === 'gh' && args[0] === 'search') {
        return JSON.stringify([
          { number: 562, body: 'Closes #561' },
        ]);
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify({
          number: 562,
          state: 'MERGED',
          title: 'fix: scarce thing',
          headRefName: 'fix/561-scarce-thing',
          body: 'Closes #561',
          mergeCommit: { oid: 'c627afc2' },
          mergedAt: '2026-05-25T00:00:00Z',
          closedAt: '2026-05-25T00:00:00Z',
        });
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'view') {
        return JSON.stringify({
          closedByPullRequestsReferences: [{ number: 562 }],
        });
      }
      if (cmd === 'git' && args[0] === 'log') {
        return `c627afc2\t\tfix: scarce thing (#561)\n`;
      }
      if (cmd === 'git' && args[0] === 'branch') {
        return `  remotes/origin/release/v2026.05.25\n`;
      }
      throw new Error(`unhandled: ${cmd} ${args.join(' ')}`);
    };

    const cap = captureWriter();
    await runTriageCheck(561, runner, cap.write);

    const parsed = JSON.parse(cap.written.join('').trim());
    expect(parsed.classification).toBe('fixed-pending-backmerge');
    expect(parsed.suggestedBlockedOn).toBe('Human');
    expect(parsed.suggestedComment).toMatch(/release\/v2026\.05\.25/);
  });
});
