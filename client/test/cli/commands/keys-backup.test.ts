import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import keysCmd from '../../../src/cli/commands/keys-backup.js';
import type { CommandContext } from '../../../src/cli/command.js';

async function makeKeystore(): Promise<{ dir: string; password: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-keys-backup-test-'));
  const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
  const { FleetStateStore } = await import('../../../src/earning/store.js');
  const mnemonic = generateMnemonic();
  const keystore = await encryptMnemonic(mnemonic, 'pw');
  const store = new FleetStateStore(dir);
  await store.saveMnemonicKeystore(keystore);
  return { dir, password: 'pw' };
}

describe('keys backup command', () => {
  it('writes the mnemonic to --output when password is correct', async () => {
    const { dir, password } = await makeKeystore();
    const outPath = join(dir, 'backup.txt');
    const ctx: CommandContext = {
      argv: ['backup', '--output', outPath],
      stdoutIsTty: false,
      writer: { write: () => true },
      exit: () => {},
      env: { JINN_PASSWORD: password, JINN_EARNING_DIR: dir },
    };
    await keysCmd.run(ctx);
    expect(existsSync(outPath)).toBe(true);
    const mnemonic = readFileSync(outPath, 'utf-8').trim();
    expect(mnemonic.split(/\s+/).length).toBeGreaterThanOrEqual(12);
  });

  it('emits a plaintext-warning line to stderr', async () => {
    const { dir, password } = await makeKeystore();
    const outPath = join(dir, 'backup.txt');
    const stderrWrites: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stderr.write;
    try {
      const ctx: CommandContext = {
        argv: ['backup', '--output', outPath],
        stdoutIsTty: false,
        writer: { write: () => true },
        exit: () => {},
        env: { JINN_PASSWORD: password, JINN_EARNING_DIR: dir },
      };
      await keysCmd.run(ctx);
    } finally {
      process.stderr.write = origWrite;
    }
    const joined = stderrWrites.join('');
    expect(joined).toMatch(/\[warn\] Mnemonic written in plaintext/);
    expect(joined).toMatch(/seed material/);
  });

  it('missing --output emits invalid_invocation', async () => {
    const { dir, password } = await makeKeystore();
    const writes: string[] = [];
    const exits: number[] = [];
    const ctx: CommandContext = {
      argv: ['backup'],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); },
      env: { JINN_PASSWORD: password, JINN_EARNING_DIR: dir },
    };
    await keysCmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--output');
    expect(exits).toEqual([11]);
  });

  it('missing password (env, fd, and file all absent) emits invalid_invocation', async () => {
    const { dir } = await makeKeystore();
    const writes: string[] = [];
    const exits: number[] = [];
    // Point HOME at a fresh temp dir so the file-fallback in resolveCliPassword
    // cannot find a real ~/.jinn-client/keystore-password on the test machine.
    const fakeHome = mkdtempSync(join(tmpdir(), 'jinn-keys-backup-home-'));
    const ctx: CommandContext = {
      argv: ['backup', '--output', join(dir, 'x.txt')],
      stdoutIsTty: false,
      writer: { write: (s: string) => { writes.push(s); return true; } },
      exit: (c: number) => { exits.push(c); },
      env: { JINN_EARNING_DIR: dir, HOME: fakeHome },
    };
    await keysCmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('keystore password');
    expect(exits).toEqual([11]);
  });
});
