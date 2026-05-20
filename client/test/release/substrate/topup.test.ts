import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';
import { checkSubstrateTopup } from '../../../scripts/release/substrate-topup';
import { spawnAnvilFork, type AnvilForkHandle } from './helpers/anvil-fork';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('substrate-topup', () => {
  let tmpRoot: string;
  let anvil: AnvilForkHandle;
  const opAFixture = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-topup-'));
    anvil = await spawnAnvilFork();
    await adoptOperator({ sourceDir: opAFixture, opName: 'op-a', role: 'launcher', shape: 'current', apiPort: 7332, substrateRoot: tmpRoot });
    // Override the manifest's rpcUrl to the local Anvil for the test
    const manifestPath = path.join(tmpRoot, 'operators', 'op-a', 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.config.rpcUrl = anvil.rpcUrl;
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  });

  afterEach(async () => {
    await anvil.stop();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('reports ok=false when master ETH balance is zero', async () => {
    const result = await checkSubstrateTopup('op-a', { substrateRoot: tmpRoot });
    expect(result.ok).toBe(false);
    expect(result.needs.some((n) => n.resource === 'ETH' && n.have === 0n)).toBe(true);
  });

  it('reports the ETH delta to topup', async () => {
    const result = await checkSubstrateTopup('op-a', { substrateRoot: tmpRoot });
    const ethNeed = result.needs.find((n) => n.resource === 'ETH');
    expect(ethNeed).toBeDefined();
    expect(ethNeed!.want).toBeGreaterThan(ethNeed!.have);
  });
});
