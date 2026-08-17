import { describe, expect, it } from 'vitest';
import {
  getRunningVersion,
  isVersionCheckEnabled,
  fetchLatestVersion,
  isNewerVersion,
  formatUpdateLogLine,
  VERSION_CHECK_INTERVAL_MS,
} from '../../src/preflight/version-check.js';
import { buildInfo } from '../../src/build-info.js';

describe('getRunningVersion', () => {
  it('returns buildInfo.implVersion', () => {
    expect(getRunningVersion()).toBe(buildInfo.implVersion);
  });
});

describe('isVersionCheckEnabled', () => {
  it('defaults on when the var is unset', () => {
    expect(isVersionCheckEnabled({})).toBe(true);
  });

  it('is on for truthy strings', () => {
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: '1' })).toBe(true);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: 'true' })).toBe(true);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: 'yes' })).toBe(true);
  });

  it('is off for the opt-out strings', () => {
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: '0' })).toBe(false);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: 'false' })).toBe(false);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: 'no' })).toBe(false);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: '' })).toBe(false);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: ' FALSE ' })).toBe(false);
    expect(isVersionCheckEnabled({ JINN_VERSION_CHECK: ' No ' })).toBe(false);
  });
});

describe('fetchLatestVersion', () => {
  function okFetch(body: unknown): typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    })) as unknown as typeof fetch;
  }

  it('returns the version on a 200 with a well-formed body', async () => {
    const result = await fetchLatestVersion({ fetchImpl: okFetch({ version: '1.2.3' }) });
    expect(result).toBe('1.2.3');
  });

  it('returns null on a non-200 response', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      json: async () => ({ version: '1.2.3' }),
    })) as unknown as typeof fetch;
    expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
  });

  it('returns null when .version is missing or malformed', async () => {
    expect(await fetchLatestVersion({ fetchImpl: okFetch({}) })).toBeNull();
    expect(await fetchLatestVersion({ fetchImpl: okFetch({ version: 42 }) })).toBeNull();
    expect(await fetchLatestVersion({ fetchImpl: okFetch('not json') })).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(fetchLatestVersion({ fetchImpl })).resolves.toBeNull();
  });

  it('returns null when the request aborts / times out', async () => {
    const fetchImpl = ((_url: string, opts?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      })) as unknown as typeof fetch;
    await expect(
      fetchLatestVersion({ fetchImpl, timeoutMs: 1 }),
    ).resolves.toBeNull();
  });
});

describe('isNewerVersion', () => {
  it('is true when latest > running', () => {
    expect(isNewerVersion('0.1.8', '0.2.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '1.0.1')).toBe(true);
  });

  it('is false when latest equals or is older than running', () => {
    expect(isNewerVersion('0.2.0', '0.2.0')).toBe(false);
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(false);
  });

  it('is false when the running build is a canary ahead of the registry latest (#641)', () => {
    // The holder must stay null here so the dashboard banner does not advertise
    // a downgrade (registry latest) as an upgrade over a newer local canary.
    expect(isNewerVersion('0.2.0-canary.1', '0.1.9')).toBe(false);
  });

  it('treats the dev placeholder as older than any real release', () => {
    expect(isNewerVersion('0.0.0-dev', '0.1.0')).toBe(true);
  });

  it('is false (never throws) for unparseable inputs', () => {
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false);
    expect(isNewerVersion('1.0.0', 'garbage')).toBe(false);
  });
});

describe('formatUpdateLogLine', () => {
  it('names the version and the upgrade command', () => {
    expect(formatUpdateLogLine('1.2.3')).toBe(
      '[version] v1.2.3 of @jinn-network/operator is available — run `jinn update` and restart to pick it up',
    );
  });
});

describe('VERSION_CHECK_INTERVAL_MS', () => {
  it('is a positive interval', () => {
    expect(VERSION_CHECK_INTERVAL_MS).toBeGreaterThan(0);
  });
});
