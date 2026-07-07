import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = resolve(TEST_DIR, '..', '..');

type RunResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
};

function runSnapshotEntrypointWithoutRpc(): Promise<RunResult> {
  return new Promise((resolveRun, reject) => {
    const env = { ...process.env };
    delete env['BASE_RPC_URL'];

    const child = spawn('yarn', ['tsx', '../contracts/scripts/build-anvil-snapshot.ts'], {
      cwd: CLIENT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', (code, signal) => {
      resolveRun({
        code,
        signal,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

describe('build-anvil-snapshot documented entrypoint', () => {
  it('reaches the script BASE_RPC_URL validation before any ESM dependency resolution failure', async () => {
    const result = await runSnapshotEntrypointWithoutRpc();

    expect(result.signal).toBeNull();
    expect(result.code).toBe(1);
    expect(result.output).toContain('BASE_RPC_URL is required');
    expect(result.output).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find package/);
  });
});
