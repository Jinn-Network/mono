import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';
import { verifySubstrate } from '../../../scripts/release/substrate-verify';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('substrate-adopt', () => {
  let tmpRoot: string;
  const fixtureDir = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-adopt-'));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('copies a source operator dir into gold with the expected layout', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const goldOp = path.join(tmpRoot, 'operators', 'op-a');
    await expect(fs.access(path.join(goldOp, 'manifest.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'config.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'earning', 'earning_state.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(goldOp, '.jinn-client', 'keystore-password'))).resolves.toBeUndefined();
  });

  it('writes a manifest matching the source operator state', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const manifestRaw = await fs.readFile(path.join(tmpRoot, 'operators', 'op-a', 'manifest.json'), 'utf-8');
    const manifest = JSON.parse(manifestRaw);
    expect(manifest.name).toBe('op-a');
    expect(manifest.shape).toBe('current');
    expect(manifest.role).toBe('launcher');
    expect(manifest.network).toBe('base-sepolia');
    expect(manifest.operator.masterAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(manifest.operator.fleetAgentId).toBe('99001');
    expect(manifest.config.apiPort).toBe(7332);
  });

  it('rewrites apiPort in the copied config.json', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7340,
      substrateRoot: tmpRoot,
    });

    const cfgRaw = await fs.readFile(path.join(tmpRoot, 'operators', 'op-a', '.jinn-client', 'config.json'), 'utf-8');
    const cfg = JSON.parse(cfgRaw);
    expect(cfg.apiPort).toBe(7340);
  });

  it('excludes engine/, logs, and backups from the copy', async () => {
    // seed the source dir with some junk to make sure it's excluded
    const dirtySource = await fs.mkdtemp(path.join(os.tmpdir(), 'dirty-source-'));
    await fs.cp(fixtureDir, path.join(dirtySource, '.jinn-client'), { recursive: true });
    await fs.mkdir(path.join(dirtySource, '.jinn-client', 'engine', 'work'), { recursive: true });
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'engine', 'work', 'fake-task.json'), '{}');
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'daemon-20260101.log'), 'old');
    await fs.writeFile(path.join(dirtySource, '.jinn-client', 'jinn.db.bak-20260101'), 'backup');

    await adoptOperator({
      sourceDir: path.join(dirtySource, '.jinn-client'),
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });

    const goldOp = path.join(tmpRoot, 'operators', 'op-a', '.jinn-client');
    await expect(fs.access(path.join(goldOp, 'engine'))).rejects.toThrow();
    await expect(fs.access(path.join(goldOp, 'daemon-20260101.log'))).rejects.toThrow();
    await expect(fs.access(path.join(goldOp, 'jinn.db.bak-20260101'))).rejects.toThrow();

    await fs.rm(dirtySource, { recursive: true, force: true });
  });

  it('adopted op-a passes substrate-verify (skip on-chain)', async () => {
    await adoptOperator({
      sourceDir: fixtureDir,
      opName: 'op-a',
      role: 'launcher',
      shape: 'current',
      apiPort: 7332,
      substrateRoot: tmpRoot,
    });
    const result = await verifySubstrate('op-a', { substrateRoot: tmpRoot, skipOnChain: true });
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('throws when source has no services in earning_state', async () => {
    const noServicesSrc = await fs.mkdtemp(path.join(os.tmpdir(), 'adopt-no-svc-'));
    await fs.cp(fixtureDir, path.join(noServicesSrc, '.jinn-client'), { recursive: true });
    // Rewrite earning_state.json with empty services array
    const statePath = path.join(noServicesSrc, '.jinn-client', 'earning', 'earning_state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf-8'));
    state.services = [];
    await fs.writeFile(statePath, JSON.stringify(state));

    await expect(
      adoptOperator({
        sourceDir: path.join(noServicesSrc, '.jinn-client'),
        opName: 'op-a',
        role: 'launcher',
        shape: 'current',
        apiPort: 7332,
        substrateRoot: tmpRoot,
      }),
    ).rejects.toThrow(/no services entry/);

    await fs.rm(noServicesSrc, { recursive: true, force: true });
  });

  it('throws when source config.json has no rpcUrl', async () => {
    const noRpcSrc = await fs.mkdtemp(path.join(os.tmpdir(), 'adopt-no-rpc-'));
    await fs.cp(fixtureDir, path.join(noRpcSrc, '.jinn-client'), { recursive: true });
    const cfgPath = path.join(noRpcSrc, '.jinn-client', 'config.json');
    const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    delete cfg.rpcUrl;
    await fs.writeFile(cfgPath, JSON.stringify(cfg));

    await expect(
      adoptOperator({
        sourceDir: path.join(noRpcSrc, '.jinn-client'),
        opName: 'op-a',
        role: 'launcher',
        shape: 'current',
        apiPort: 7332,
        substrateRoot: tmpRoot,
      }),
    ).rejects.toThrow(/rpcUrl/);

    await fs.rm(noRpcSrc, { recursive: true, force: true });
  });
});
