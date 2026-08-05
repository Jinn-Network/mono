import { describe, expect, it } from 'vitest';
import {
  createOnboardingCompleteCommand,
  type OnboardingCompleteDeps,
} from '../../../src/cli/commands/onboarding-complete.js';
import { runCommand } from '@test/cli.js';
import type { DaemonPostResult } from '../../../src/cli/daemon-control-client.js';
import type { OnboardingCompleteIntentResult } from '../../../src/intents/onboarding-complete.js';

const defaultConfig = { apiPort: 7331 };

function makeDeps(overrides: {
  postToDaemon?: (opts: { apiPort: number; path: string }) => Promise<DaemonPostResult<any>>;
  onboardingCompleteIntent?: (input: any) => Promise<OnboardingCompleteIntentResult>;
} = {}): OnboardingCompleteDeps {
  return {
    loadConfig: () => defaultConfig as any,
    getConfigPathFromArgs: () => undefined,
    postToDaemon: (overrides.postToDaemon ?? (async () => ({ reachable: false, error: 'ECONNREFUSED' }))) as any,
    onboardingCompleteIntent: (overrides.onboardingCompleteIntent ?? (async () => ({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      verb: 'onboarding-complete',
      ok: true,
      onboardingComplete: true,
    }))) as any,
  };
}

describe('jinn onboarding-complete', () => {
  it('tier 1: mutates via the daemon control route when reachable', async () => {
    let calledIntent = false;
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: true, status: 200, body: { ok: true, onboardingComplete: true } }),
      onboardingCompleteIntent: async () => {
        calledIntent = true;
        throw new Error('should not be called when daemon is reachable');
      },
    });
    const cmd = createOnboardingCompleteCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });

    expect(calledIntent).toBe(false);
    expect(result.exits).toEqual([0]);
    expect(result.envelopes[0]).toMatchObject({ ok: true, source: 'daemon' });
  });

  it('tier 1 failure: emits fatal when the daemon reports ok:false', async () => {
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: true, status: 500, body: { ok: false, error: 'config_write_failed' } }),
    });
    const cmd = createOnboardingCompleteCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });
    expect(result.envelopes[0]).toMatchObject({ code: 'fatal' });
  });

  it('tier 2: falls back to the standalone intent when the daemon is unreachable', async () => {
    let calledIntentWith: unknown;
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
      onboardingCompleteIntent: async (input) => {
        calledIntentWith = input;
        return {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          verb: 'onboarding-complete',
          ok: true,
          onboardingComplete: true,
        };
      },
    });
    const cmd = createOnboardingCompleteCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });

    expect(calledIntentWith).toEqual({ configPath: undefined });
    expect(result.exits).toEqual([0]);
    expect(result.envelopes[0]).toMatchObject({ ok: true, source: 'standalone' });
  });

  it('tier 2 failure: emits fatal when the standalone intent fails', async () => {
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
      onboardingCompleteIntent: async () => ({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        verb: 'onboarding-complete',
        ok: false,
        onboardingComplete: false,
        error: 'disk full',
      }),
    });
    const cmd = createOnboardingCompleteCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });
    expect(result.envelopes[0]).toMatchObject({ code: 'fatal' });
  });

  it('emits invalid_invocation on unparseable flags', async () => {
    const deps = makeDeps();
    const cmd = createOnboardingCompleteCommand(deps);
    const result = await runCommand(cmd, { argv: ['--nonexistent-flag'] });
    expect(result.envelopes[0]).toMatchObject({ code: 'invalid_invocation' });
  });
});
