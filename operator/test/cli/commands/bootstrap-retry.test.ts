import { describe, expect, it } from 'vitest';
import { createBootstrapRetryCommand, type BootstrapRetryDeps } from '../../../src/cli/commands/bootstrap-retry.js';
import { runCommand } from '@test/cli.js';
import type { DaemonPostResult } from '../../../src/cli/daemon-control-client.js';

const defaultConfig = { apiPort: 7331 };

function makeDeps(overrides: {
  postToDaemon?: (opts: { apiPort: number; path: string }) => Promise<DaemonPostResult<{ ok: boolean; error?: string }>>;
} = {}): BootstrapRetryDeps {
  return {
    loadConfig: () => defaultConfig as any,
    getConfigPathFromArgs: () => undefined,
    postToDaemon: (overrides.postToDaemon ?? (async () => ({ reachable: true, status: 200, body: { ok: true } }))) as any,
  };
}

describe('jinn bootstrap-retry', () => {
  it('posts to /v1/setup/bootstrap/retry on the configured apiPort and succeeds', async () => {
    let calledWith: { apiPort: number; path: string } | undefined;
    const deps = makeDeps({
      postToDaemon: async (opts) => {
        calledWith = opts;
        return { reachable: true, status: 200, body: { ok: true } };
      },
    });
    const cmd = createBootstrapRetryCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });

    expect(calledWith).toEqual({ apiPort: 7331, path: '/v1/setup/bootstrap/retry' });
    expect(result.exits).toEqual([0]);
    expect(result.envelopes[0]).toMatchObject({ ok: true, verb: 'bootstrap-retry' });
  });

  it('emits invalid_invocation when the daemon is unreachable', async () => {
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: false, error: 'ECONNREFUSED' }),
    });
    const cmd = createBootstrapRetryCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });

    expect(result.envelopes[0]).toMatchObject({ code: 'invalid_invocation' });
  });

  it('emits fatal when the daemon reports ok:false (e.g. not currently halted)', async () => {
    const deps = makeDeps({
      postToDaemon: async () => ({ reachable: true, status: 500, body: { ok: false, error: 'daemon_not_halted' } }),
    });
    const cmd = createBootstrapRetryCommand(deps);
    const result = await runCommand(cmd, { argv: ['--json'] });

    expect(result.envelopes[0]).toMatchObject({ code: 'fatal' });
  });

  it('emits invalid_invocation on unparseable flags', async () => {
    const deps = makeDeps();
    const cmd = createBootstrapRetryCommand(deps);
    const result = await runCommand(cmd, { argv: ['--nonexistent-flag'] });
    expect(result.envelopes[0]).toMatchObject({ code: 'invalid_invocation' });
  });
});
