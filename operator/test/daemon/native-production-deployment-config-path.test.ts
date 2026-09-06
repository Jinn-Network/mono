import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NativeProductionDeploymentError,
  preflightNativeRequesterCommand,
} from '@/daemon/native-production-deployment.js';

/**
 * #2393: the native production deployment path scanned `process.argv` for the
 * two-token `--config <path>` form only, so
 * `jinn native-vertical request --config=/opt/jinn/requester.json` parsed
 * cleanly (COMMON_FLAGS accepts `config`) and then silently loaded the default
 * state-dir config. This path validates on-chain funding, escrow, and
 * transaction caps, so a silent fallback is the highest-consequence instance
 * of the harm this issue closes.
 *
 * The resolved path is observable in the config-missing error message, which
 * is the cheapest way to assert resolution without standing up a chain
 * fixture.
 */
describe('native production deployment config path (#2393)', () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  function missingConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), 'jinn-native-config-')), 'requester.json');
  }

  async function resolvedPathFrom(argv: readonly string[]): Promise<string> {
    process.argv = ['node', 'jinn', ...argv];
    const error = await preflightNativeRequesterCommand({
      network: 'base-sepolia',
      fixture: 'prediction-forecast-golden.json',
      runId: 'issue-2393',
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(NativeProductionDeploymentError);
    const message = (error as Error).message;
    expect(message).toContain('native structured config is missing: ');
    return message.slice('native structured config is missing: '.length);
  }

  it('resolves the --config equals form', async () => {
    const path = missingConfigPath();
    expect(await resolvedPathFrom(['native-vertical', 'request', `--config=${path}`])).toBe(path);
  });

  it('resolves the --config space-separated form to the same path', async () => {
    const path = missingConfigPath();
    expect(await resolvedPathFrom(['native-vertical', 'request', '--config', path])).toBe(path);
  });
});
