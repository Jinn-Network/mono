/**
 * Shared test helpers for the `jinn solver-plugins ...` CLI test files.
 *
 * Kept in a non-`.test.ts` module so importing it from other test files does
 * not cause Vitest's `include` glob to double-collect the importer's
 * describe blocks. The publish test file imports these helpers too — it
 * does NOT re-define them locally — so behaviour stays in one place.
 */

import { afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../../src/cli/command.js';

export const tempDirs: string[] = [];

export function withTempPlugin(name = 'test-plugin', version = '0.1.0'): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-plugin-'));
  tempDirs.push(dir);
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'jinn.plugin.json'),
    JSON.stringify(
      {
        name,
        version,
        jinn: { supports: ['swe-rebench-v2.v1'] },
      },
      null,
      2,
    ),
  );
  return root;
}

export function withTempConfig(extra: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-config-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      rpcUrl: 'http://127.0.0.1:8545',
      network: 'testnet',
      earningDir: dir,
      ipfsRegistryUrl: 'https://registry.autonolas.tech',
      ...extra,
    }),
    'utf-8',
  );
  return configPath;
}

export function makeCtx(
  argv: string[],
  envOverride?: NodeJS.ProcessEnv,
): {
  ctx: CommandContext;
  writes: string[];
  exits: number[];
} {
  const writes: string[] = [];
  const exits: number[] = [];
  const ctx: CommandContext = {
    argv,
    stdoutIsTty: false,
    writer: {
      write: (s) => {
        writes.push(s);
        return true;
      },
    },
    exit: (code) => {
      exits.push(code);
    },
    env: envOverride ?? { JINN_PASSWORD: 'test' },
  };
  return { ctx, writes, exits };
}

export function parsedLine(writes: string[]): Record<string, unknown> {
  const joined = writes.join('');
  const line = joined
    .trim()
    .split('\n')
    .filter((s) => s.startsWith('{'))
    .pop();
  return JSON.parse(line!);
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTempDirs();
});
