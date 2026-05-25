import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { adoptOperator } from '../../../scripts/release/substrate-adopt';
import { copyWorkspace } from '../../../scripts/release/substrate-copy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('substrate-copy', () => {
  let tmpRoot: string;
  const opAFixture = path.resolve(__dirname, 'fixtures', 'op-a-fixture', '.jinn-client');
  const opBFixture = path.resolve(__dirname, 'fixtures', 'op-b-fixture', '.jinn-client');

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'substrate-copy-'));
    await adoptOperator({ sourceDir: opAFixture, opName: 'op-a', role: 'launcher', shape: 'current', apiPort: 7332, substrateRoot: tmpRoot });
    await adoptOperator({ sourceDir: opBFixture, opName: 'op-b', role: 'participant', shape: 'current', apiPort: 7333, substrateRoot: tmpRoot });
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('creates per-run workspace from gold', async () => {
    const handle = await copyWorkspace({ ops: ['op-a', 'op-b'], substrateRoot: tmpRoot });
    expect(handle.runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/);

    for (const opName of ['op-a', 'op-b']) {
      const wsOp = path.join(handle.workspaceRoot, opName);
      await expect(fs.access(path.join(wsOp, 'manifest.json'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(wsOp, '.jinn-client', 'config.json'))).resolves.toBeUndefined();
    }
  });

  it('teardown removes the workspace dir', async () => {
    const handle = await copyWorkspace({ ops: ['op-a'], substrateRoot: tmpRoot });
    expect(handle.workspaceRoot).toContain('workspaces');
    await fs.access(handle.workspaceRoot);
    await handle.teardown();
    await expect(fs.access(handle.workspaceRoot)).rejects.toThrow();
  });

  it('teardown is idempotent', async () => {
    const handle = await copyWorkspace({ ops: ['op-a'], substrateRoot: tmpRoot });
    await handle.teardown();
    await expect(handle.teardown()).resolves.toBeUndefined();
  });

  it('returns per-op paths for ergonomic use', async () => {
    const handle = await copyWorkspace({ ops: ['op-a', 'op-b'], substrateRoot: tmpRoot });
    expect(handle.opPaths['op-a']).toContain('op-a');
    expect(handle.opPaths['op-b']).toContain('op-b');
    expect(handle.opPaths['op-a']).not.toContain('op-b');
  });

  it('throws if requested op is not in gold', async () => {
    await expect(copyWorkspace({ ops: ['op-z'], substrateRoot: tmpRoot })).rejects.toThrow(/op-z/);
  });

  it('throws if ops is empty', async () => {
    await expect(copyWorkspace({ ops: [], substrateRoot: tmpRoot })).rejects.toThrow(/non-empty/);
  });
});
