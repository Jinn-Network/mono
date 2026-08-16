/**
 * `gatherIntrospectionRaw`'s `/v1/status` merge (spec §10.1, issue #2404).
 *
 * `/v1/status` is now token-gated (§14.5) — the merge fetch sends the on-disk UI token via
 * `resolveUiToken()` (the same resolver `daemon-control-client.ts` uses). A 401 is an
 * explicit, actionable `IntrospectionUnauthorizedError` rather than a silently-swallowed
 * fallback; a connection failure (no daemon listening) still falls back to the local gather.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApiServer, type ApiServer } from '../../src/api/server.js';
import { Store } from '../../src/store/store.js';
import { defaultTokenPath } from '../../src/api/ui-token.js';
import {
  gatherIntrospectionRaw,
  IntrospectionUnauthorizedError,
} from '../../src/cli/introspection-context.js';

const TEST_TOKEN = 'test-ui-token-789';

let store: Store;
let server: ApiServer | undefined;
let configPath: string;

function writeConfig(apiPort: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-introspection-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ apiPort }));
  return path;
}

beforeEach(async () => {
  store = new Store(':memory:');
  server = await startApiServer({
    port: 0,
    store,
    apiToken: 'bearer-not-used-here',
    ui: { token: TEST_TOKEN, handshakeKey: 'handshake-key' },
  });
  configPath = writeConfig(server.port);
});

afterEach(async () => {
  await server?.close();
  store.close();
});

describe('gatherIntrospectionRaw — /v1/status auth (spec §10.1)', () => {
  it('throws IntrospectionUnauthorizedError when no UI token is on disk', async () => {
    await expect(
      gatherIntrospectionRaw({ argv: ['--config', configPath] }),
    ).rejects.toBeInstanceOf(IntrospectionUnauthorizedError);
  });

  it('throws IntrospectionUnauthorizedError when the on-disk token is stale/wrong', async () => {
    writeFileSync(defaultTokenPath(), 'wrong-token\n', { mode: 0o600 });
    await expect(
      gatherIntrospectionRaw({ argv: ['--config', configPath] }),
    ).rejects.toBeInstanceOf(IntrospectionUnauthorizedError);
  });

  it('merges the remote status when the correct UI token is on disk', async () => {
    writeFileSync(defaultTokenPath(), `${TEST_TOKEN}\n`, { mode: 0o600 });
    const raw = await gatherIntrospectionRaw({ argv: ['--config', configPath] });
    expect(raw).toBeDefined();
  });

  it('falls back to the local gather (no throw) when the daemon is unreachable', async () => {
    await server!.close();
    server = undefined;
    const raw = await gatherIntrospectionRaw({ argv: ['--config', configPath] });
    expect(raw).toBeDefined();
  });
});
