import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
    vi.stubEnv('JINN_EARNING_DIR', '');
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /**
   * A host whose default operator has a real keystore, plus the auto-generated
   * `keystore-password` file that opens it — the shape `jinn run` leaves behind.
   */
  async function makeDefaultOperator(options: { password?: string } = {}): Promise<{
    home: string;
    defaultEarningDir: string;
    passwordFile: string;
    password: string;
  }> {
    const password = options.password ?? 'default-operator-pw';
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const stateDir = join(home, '.jinn-operator');
    const defaultEarningDir = join(stateDir, 'earning');
    mkdirSync(defaultEarningDir, { recursive: true });
    const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    await new FleetStateStore(defaultEarningDir).saveMnemonicKeystore(
      await encryptMnemonic(generateMnemonic(), password),
    );
    const passwordFile = join(stateDir, 'keystore-password');
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });
    return { home, defaultEarningDir, passwordFile, password };
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

  async function expectDecryptsWith(dir: string, password: string): Promise<void> {
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    const { decryptMnemonic } = await import('../../../src/earning/wallet.js');
    const reloaded = await new FleetStateStore(dir).loadMnemonicKeystore();
    await expect(decryptMnemonic(reloaded, password)).resolves.toBeTruthy();
  }

  // #2515: rotating operator B must not delete operator A's password file.
  it('leaves the default password file alone when another earning dir is targeted', async () => {
    const { home, passwordFile, password: defaultPassword } = await makeDefaultOperator();
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
    // The default operator's password file — and so its keystore — must survive.
    expect(existsSync(passwordFile)).toBe(true);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(defaultPassword);

    // And the targeted keystore really was re-encrypted with the new password.
    await expectDecryptsWith(dir, 'brand-new-password');
  });

  // The two-operator ceremony that surfaced #2515 had reconciled both operators
  // onto one password, so "is this the password we just rotated away from" is not
  // enough on its own to decide the file is stale.
  it('leaves the default password file alone even when both operators share a password', async () => {
    const shared = 'shared-operator-pw';
    const { home, passwordFile } = await makeDefaultOperator({ password: shared });
    const otherDir = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-op-b-'));
    const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    await new FleetStateStore(otherDir).saveMnemonicKeystore(
      await encryptMnemonic(generateMnemonic(), shared),
    );

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: otherDir,
      JINN_PASSWORD: shared,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(existsSync(passwordFile)).toBe(true);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(shared);
  });

  it('deletes the password file when the default earning dir is the target', async () => {
    const { home, defaultEarningDir, passwordFile, password } = await makeDefaultOperator();

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: defaultEarningDir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    const result = JSON.parse(writes[writes.length - 1]!);
    expect(result.passwordFileDeleted).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
    await expectDecryptsWith(defaultEarningDir, 'brand-new-password');
  });

  // Single operator on a custom earning dir: the auto-generated file is that
  // operator's own boot password, so leaving it behind would wedge the next `jinn run`.
  it('deletes the password file when it opens no default keystore', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const stateDir = join(home, '.jinn-operator');
    mkdirSync(stateDir, { recursive: true });
    const passwordFile = join(stateDir, 'keystore-password');
    const { dir, password } = await makeKeystore();
    writeFileSync(passwordFile, `${password}\n`, { mode: 0o600 });

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    const result = JSON.parse(writes[writes.length - 1]!);
    expect(result.passwordFileDeleted).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
    await expectDecryptsWith(dir, 'brand-new-password');
  });

  it('resolves the default state dir from JINN_STATE_DIR', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const stateDir = join(mkdtempSync(join(tmpdir(), 'jinn-keys-cp-state-')), 'state');
    const defaultEarningDir = join(stateDir, 'earning');
    mkdirSync(defaultEarningDir, { recursive: true });
    const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    await new FleetStateStore(defaultEarningDir).saveMnemonicKeystore(
      await encryptMnemonic(generateMnemonic(), 'pw'),
    );
    const passwordFile = join(stateDir, 'keystore-password');
    writeFileSync(passwordFile, 'pw\n', { mode: 0o600 });

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_STATE_DIR: stateDir,
      JINN_EARNING_DIR: defaultEarningDir,
      JINN_PASSWORD: 'pw',
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
  });

  it('honors --config for the earning dir', async () => {
    vi.stubEnv('JINN_EARNING_DIR', '');
    const { home, passwordFile } = await makeDefaultOperator();
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

  it('lets JINN_EARNING_DIR win over --config', async () => {
    const { home } = await makeDefaultOperator();
    const { dir, password } = await makeKeystore();
    const configPath = join(mkdtempSync(join(tmpdir(), 'jinn-keys-cp-config-')), 'config.json');
    writeFileSync(configPath, JSON.stringify({ earningDir: join(home, 'nowhere') }));

    const { ctx, writes } = makeCtx(['change-password', '--config', configPath, '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).keystoreDir).toBe(dir);
  });

  it('resolves the legacy ~/.jinn-client tree when it is the populated one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const legacyStateDir = join(home, '.jinn-client');
    const legacyEarningDir = join(legacyStateDir, 'earning');
    mkdirSync(legacyEarningDir, { recursive: true });
    const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
    const { FleetStateStore } = await import('../../../src/earning/store.js');
    await new FleetStateStore(legacyEarningDir).saveMnemonicKeystore(
      await encryptMnemonic(generateMnemonic(), 'pw'),
    );
    const passwordFile = join(legacyStateDir, 'keystore-password');
    writeFileSync(passwordFile, 'pw\n', { mode: 0o600 });

    // Rotating another operator must leave the legacy tree's password file alone.
    const { dir, password } = await makeKeystore();
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(existsSync(passwordFile)).toBe(true);
  });

  // A corrupt default keystore throws exactly like a wrong password. Keep the file:
  // it may be the only thing that still opens a keystore restored from backup.
  it('keeps the password file when the default keystore is corrupt', async () => {
    const { home, defaultEarningDir, passwordFile } = await makeDefaultOperator();
    writeFileSync(join(defaultEarningDir, 'master_keystore.json'), 'not json at all');
    const { dir, password } = await makeKeystore();

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(existsSync(passwordFile)).toBe(true);
  });

  it('keeps the password file when the default keystore has an unrecognized shape', async () => {
    const { home, defaultEarningDir, passwordFile } = await makeDefaultOperator();
    writeFileSync(
      join(defaultEarningDir, 'master_keystore.json'),
      JSON.stringify({ type: 'some-future-format', keystore: {} }),
    );
    const { dir, password } = await makeKeystore();

    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home,
      JINN_EARNING_DIR: dir,
      JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(existsSync(passwordFile)).toBe(true);
  });

  it.each(['mnemonic_obfuscated', 'master_address', 'keystore'] as const)(
    'preserves another operator password when its %s payload is damaged',
    async (field) => {
      const { home, defaultEarningDir, passwordFile, password: defaultPassword } = await makeDefaultOperator();
      const keystorePath = join(defaultEarningDir, 'master_keystore.json');
      const payload = JSON.parse(readFileSync(keystorePath, 'utf-8'));
      // Damage outside the V3 key still leaves the private key recoverable with
      // this password. A failed mnemonic reconstruction is not a stale password.
      if (field === 'keystore') payload.keystore = {};
      else payload[field] = '00';
      if (field !== 'keystore') {
        const { Wallet } = await import('@ethereumjs/wallet');
        await expect(Wallet.fromV3(payload.keystore, defaultPassword)).resolves.toBeTruthy();
      }
      writeFileSync(keystorePath, JSON.stringify(payload));
      const dir = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-op-b-'));
      const { FleetStateStore } = await import('../../../src/earning/store.js');
      const { generateMnemonic, encryptMnemonic } = await import('../../../src/earning/wallet.js');
      await new FleetStateStore(dir).saveMnemonicKeystore(
        await encryptMnemonic(generateMnemonic(), defaultPassword),
      );
      const { ctx, writes } = makeCtx(['change-password', '--json'], {
        HOME: home, JINN_EARNING_DIR: dir, JINN_PASSWORD: defaultPassword,
        JINN_NEW_PASSWORD: 'brand-new-password',
      });

      await keysCmd.run(ctx);

      expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
      expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(defaultPassword);
      await expectDecryptsWith(dir, 'brand-new-password');
    },
  );

  it('recognizes a directory symlink to the default earning dir during rotation', async () => {
    const { home, defaultEarningDir, passwordFile, password } = await makeDefaultOperator();
    const alias = join(home, 'earning-alias');
    symlinkSync(defaultEarningDir, alias, 'dir');
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home, JINN_EARNING_DIR: alias, JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(true);
    expect(existsSync(passwordFile)).toBe(false);
    await expectDecryptsWith(defaultEarningDir, 'brand-new-password');
  });

  it('preserves a default keystore reached through a file symlink replaced by rotation', async () => {
    const { home, defaultEarningDir, passwordFile, password } = await makeDefaultOperator();
    const aliasDir = join(home, 'other-earning');
    mkdirSync(aliasDir);
    symlinkSync(join(defaultEarningDir, 'master_keystore.json'), join(aliasDir, 'master_keystore.json'));
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home, JINN_EARNING_DIR: aliasDir, JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(password);
    await expectDecryptsWith(defaultEarningDir, password);
    await expectDecryptsWith(aliasDir, 'brand-new-password');
  });

  it('preserves the password when the default keystore is a dangling symlink', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const defaultEarningDir = join(home, '.jinn-operator', 'earning');
    mkdirSync(defaultEarningDir, { recursive: true });
    symlinkSync(join(home, 'unavailable-keystore'), join(defaultEarningDir, 'master_keystore.json'));
    const { dir, password } = await makeKeystore();
    const passwordFile = join(home, '.jinn-operator', 'keystore-password');
    writeFileSync(passwordFile, password + '\n', { mode: 0o600 });
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home, JINN_EARNING_DIR: dir, JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(password);
    await expectDecryptsWith(dir, 'brand-new-password');
  });

  it('preserves a password file when the new password is unchanged', async () => {
    const { home, defaultEarningDir, passwordFile, password } = await makeDefaultOperator();
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home, JINN_EARNING_DIR: defaultEarningDir, JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: password,
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe(password);
  });

  it('preserves an unrelated password file when the default keystore is absent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'jinn-keys-cp-home-'));
    const stateDir = join(home, '.jinn-operator');
    mkdirSync(stateDir, { recursive: true });
    const passwordFile = join(stateDir, 'keystore-password');
    writeFileSync(passwordFile, 'another-operator-password\n', { mode: 0o600 });
    const { dir, password } = await makeKeystore();
    const { ctx, writes } = makeCtx(['change-password', '--json'], {
      HOME: home, JINN_EARNING_DIR: dir, JINN_PASSWORD: password,
      JINN_NEW_PASSWORD: 'brand-new-password',
    });

    await keysCmd.run(ctx);

    expect(JSON.parse(writes[writes.length - 1]!).passwordFileDeleted).toBe(false);
    expect(readFileSync(passwordFile, 'utf-8').trim()).toBe('another-operator-password');
  });

  it('rejects an explicit --config that cannot be loaded', async () => {
    const { home } = await makeDefaultOperator();
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
