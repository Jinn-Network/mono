import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  SnykIssueRelaySecurityScanner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/issue-relay-security-scanner.js';

describe('SnykIssueRelaySecurityScanner', () => {
  it('binds an authenticated scanner result without exposing other evaluator credentials', async () => {
    const report = JSON.stringify({ runs: [{ results: [{ ruleId: 'typescript/xss' }] }] });
    const runProcess = vi.fn(async (_command, args: string[], options) => {
      expect(options.env).toHaveProperty('SNYK_TOKEN', 'snyk-test-token');
      expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
      expect(options.env).not.toHaveProperty('GH_TOKEN');
      return args[0] === '--version'
        ? { stdout: '1.1297.3\n', stderr: '', exitCode: 0 }
        : { stdout: report, stderr: '', exitCode: 1 };
    });
    const scanner = new SnykIssueRelaySecurityScanner({
      environment: {
        PATH: process.env.PATH,
        SNYK_TOKEN: 'snyk-test-token',
        ANTHROPIC_API_KEY: 'must-not-cross',
        GH_TOKEN: 'must-not-cross',
      },
      runProcess,
      makeTempDir: async () => '/tmp/relay-snyk-test-home',
      remove: async () => undefined,
    });

    const result = await scanner.run({
      checkoutPath: '/tmp/exact-relay-checkout',
      abort: new AbortController().signal,
    });

    expect(result).toEqual({
      evidence: {
        tool: 'snyk-code',
        version: '1.1297.3',
        status: 'findings',
        digest: `sha256:${createHash('sha256').update(report).digest('hex')}`,
        summary: 'Snyk Code completed with findings supplied to the security adjudicator.',
      },
      report,
    });
    expect(runProcess).toHaveBeenLastCalledWith(
      'snyk',
      ['code', 'test', '--json', '--severity-threshold=low'],
      expect.objectContaining({ acceptedExitCodes: [1] }),
    );
  });

  it('fails closed on malformed scanner output', async () => {
    const scanner = new SnykIssueRelaySecurityScanner({
      environment: { SNYK_TOKEN: 'snyk-test-token' },
      runProcess: vi.fn(async (_command, args: string[]) => args[0] === '--version'
        ? { stdout: '1.1297.3', stderr: '', exitCode: 0 }
        : { stdout: 'not-json', stderr: '', exitCode: 0 }),
      makeTempDir: async () => '/tmp/relay-snyk-test-home',
      remove: async () => undefined,
    });
    await expect(scanner.run({
      checkoutPath: '/tmp/exact-relay-checkout',
      abort: new AbortController().signal,
    })).rejects.toThrow();
  });
});
