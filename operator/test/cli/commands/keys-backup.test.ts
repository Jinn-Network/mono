import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

  it('honors --config for the earning dir', async () => {
    const { dir, password } = await makeKeystore();
    const outPath = join(dir, 'backup.txt');
    const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-keys-backup-config-')), 'config.json');
    writeFileSync(configPath, JSON.stringify({ earningDir: dir }));
    const ctx: CommandContext = {
      argv: ['backup', '--output', outPath, '--config', configPath],
      stdoutIsTty: false,
      writer: { write: () => true },
      exit: () => {},
      env: { JINN_PASSWORD: password },
    };
    await keysCmd.run(ctx);
    expect(existsSync(outPath)).toBe(true);
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

describe('keys change-password command', () => {
  function makeHome(): {
    home: string;
    defaultEarningDir: string;
    passwordFile: string;
  } {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const stateDir = join(home, '.jinn-operator');
    const defaultEarningDir = join(stateDir, 'earning');
    mkdirSync(defaultEarningDir, { recursive: true });
    const passwordFile = join(stateDir, 'keystore-password');
    writeFileSync(passwordFile, 'default-operator-pw\n', { mode: 0o600 });
    return { home, defaultEarningDir, passwordFile };
  }

  function makeCtx(argv: string[], env: Record<string, string>): {
    ctx: CommandContext;
    writes: string[];
    exits: number[];
  } {
    const writes: string[] = [];
    const exits: number[] = [];
    return {
      ctx: {
        argv,
        stdoutIsTty: false,
        writer: { write: (s: string) => { writes.push(s); return true; } },
        exit: (c: number) => { exits.push(c); },
        env,
      },
      writes,
      exits,
    };
  }

  it('leaves the default password file alone when another earning dir is targeted', async () => {
    const { home, passwordFile } = makeHome();
    const { dir, password } = await makeKeystore();
    const { ctx, writes, exits } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(exits).toEqual([]);
    const result = JSON.parse(writes[writes.length - 1]!);
    expect(result.verb).toBe('keys change-password');
    expect(result.keystoreDir).toBe(dir);
    expect(result.passwordFileDeleted).toBe(false);
    // The other operator's password file must survive.
    expect(existsSync(passwordFile)).toBe(true);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe('default-operator-pw');

    // And the targeted keystore really was re-encrypted with the new password.
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    const { decryptMnemonic } = await import('../../../src/earning/wallet.js');
    const reloaded = await new FleetStateStore(dir).loadMnemonicKeystore();
    await expect(decryptMnemonic(reloaded, 'brand-new-password')).resolves.toBeTruthy();
  });

  it('deletes the password file when the default earning dir is the target', async () => {
    const { home, defaultEarningDir, passwordFile } = makeHome();
    const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    await new FleetStateStore(defaultEarningDir).saveMnemonicKeystore(
      await encryptMnemonic(generateMnemonic(), 'pw'),
    );

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: defaultEarningDir,
      JINN_PASSWORD: 'pw',
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    const result = JSON.parse(writes[writes.length - 1]!);
    expect(result.passwordFileDeleted).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it('honors --config for the earning dir', async () => {
    const { home, passwordFile } = makeHome();
    const { dir, password } = await makeKeystore();
    const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-keys-cp-config-')), 'config.json');
    writeFileSync(configPath, JSON.stringify({ earningDir: dir }));

    const { ctx, writes } = makeCtx(['change-password', '--config', configPath, '--json'], {
      HOME: home,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    const result = JSON.parse(writes[writes.length - 1]!);
    expect(result.keystoreDir).toBe(dir);
    expect(result.passwordFileDeleted).toBe(false);
    expect(existsSync(passwordFile)).toBe(true);
  });

  it('rejects an explicit --config that cannot be loaded', async () => {
    const { home } = makeHome();
    const { ctx, writes, exits } = makeCtx(
      ['change-password', '--config', join(home, 'does-not-exist.json')],
      { HOME: home, JINN_PASSWORD: 'pw', JINN_NEW_PASSWORD: 'brand-new-password' },
    );

    await keysCmd.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]!);
    expect(parsed.code).toBe('invalid_invocation');
    expect(parsed.details?.field).toBe('--config');
    expect(exits).toEqual([11]);
  });
});
