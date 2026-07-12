import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJinnLayerCli } from '../src/cli.js';
import { FleetStateStore, mnemonicKeystorePath } from '../../../src/earning/store.js';
import {
  encryptMnemonic,
  generateMnemonic,
  walletPrivateKeyAtIndex,
} from '../../../src/earning/wallet.js';
import { createDefaultFleetState } from '../../../src/earning/types.js';

/** Stdout capture — same shape as cli.test.ts's local helper. */
function capture(): { writer: { write: (s: string) => boolean }; out: () => string } {
  let buf = '';
  return {
    writer: { write: (s: string) => { buf += s; return true; } },
    out: () => buf,
  };
}

async function buildEarningDir(opts: {
  password: string;
  index?: number;
  safeAddress?: string | null;
  agentId?: string | null;
  step?: string;
  withKeystore?: boolean;
  withState?: boolean;
}): Promise<{ dir: string; mnemonic: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-derive-env-'));
  const store = new FleetStateStore(dir);
  const mnemonic = generateMnemonic();
  if (opts.withKeystore !== false) {
    await store.saveMnemonicKeystore(await encryptMnemonic(mnemonic, opts.password));
  }
  if (opts.withState !== false) {
    const state = createDefaultFleetState('base-sepolia');
    state.master_address = '0x' + '0'.repeat(40);
    state.services = [
      {
        index: opts.index ?? 1,
        agent_address: '0x' + 'a'.repeat(40),
        safe_address:
          opts.safeAddress === undefined ? '0x' + 'b'.repeat(40) : opts.safeAddress,
        service_id: 42,
        mech_address: null,
        staking_address: null,
        step: (opts.step ?? 'complete') as never,
        error: null,
        agent_id: opts.agentId === undefined ? '5474' : opts.agentId,
        agent_uri: null,
        identity_registry_address: null,
        agent_registered_tx: null,
        safe_bound_to_agent: false,
        error_revert_reason: null,
        error_short_message: null,
      },
    ];
    await store.save(state);
  }
  return { dir, mnemonic };
}

describe('jinn-layer derive-env', () => {
  let stderr = '';
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    stderr = '';
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: unknown) => {
        stderr += typeof chunk === 'string' ? chunk : String(chunk);
        return true;
      });
    for (const k of ['JINN_EARNING_DIR', 'JINN_PASSWORD', 'HOME']) {
      savedEnv[k] = process.env[k];
    }
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    for (const k of ['JINN_EARNING_DIR', 'JINN_PASSWORD', 'HOME']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it('prints the three export lines given keystore + password (AC1/AC2/AC3)', async () => {
    const pw = 'test-password';
    const { dir, mnemonic } = await buildEarningDir({ password: pw });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(0);
    const expectedKey = walletPrivateKeyAtIndex(mnemonic, 1);
    const text = out();
    expect(text).toBe(
      `export JINN_LAYER_PRIVATE_KEY=${expectedKey}\n` +
        `export JINN_LAYER_SAFE_ADDRESS=0x${'b'.repeat(40)}\n` +
        `export JINN_LAYER_AGENT_ID=5474\n`,
    );
    // Exactly three export lines, no stray stdout.
    expect(text.match(/^export /gm)?.length).toBe(3);

    // AC2: the plaintext key never touches disk — the on-disk keystore does not
    // contain it. The address is logged to stderr, never the key.
    const keystoreRaw = readFileSync(mnemonicKeystorePath(dir), 'utf-8');
    expect(keystoreRaw).not.toContain(expectedKey);
    expect(keystoreRaw).not.toContain(expectedKey.slice(2));
    expect(stderr).not.toContain(expectedKey);
  });

  it('honors a non-default HD index (AC3)', async () => {
    const pw = 'pw2';
    const { dir, mnemonic } = await buildEarningDir({ password: pw, index: 2 });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(0);
    expect(out()).toContain(
      `export JINN_LAYER_PRIVATE_KEY=${walletPrivateKeyAtIndex(mnemonic, 2)}\n`,
    );
  });

  it('treats safe_binding_pending as an operational service', async () => {
    const pw = 'pw3';
    const { dir } = await buildEarningDir({ password: pw, step: 'safe_binding_pending' });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(0);
    expect(out().match(/^export /gm)?.length).toBe(3);
  });

  it('fails clean when the keystore is missing (AC5)', async () => {
    const pw = 'pw4';
    const { dir } = await buildEarningDir({ password: pw, withKeystore: false });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('no keystore');
    expect(stderr).toContain(mnemonicKeystorePath(dir));
    // No stack trace leaks.
    expect(stderr).not.toContain('\n    at ');
    expect(stderr.split('\n').filter((l) => l.length > 0).length).toBe(1);
  });

  it('fails clean when the password cannot be resolved (AC5)', async () => {
    const pw = 'pw5';
    const { dir } = await buildEarningDir({ password: pw });
    // Isolate HOME to the temp dir so no ~/.jinn-client/keystore-password is picked up.
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['HOME'] = dir;
    delete process.env['JINN_PASSWORD'];

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('derive-env:');
    expect(stderr).not.toContain('\n    at ');
  });

  it('fails clean on a wrong password (AC5)', async () => {
    const { dir } = await buildEarningDir({ password: 'correct-pw' });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = 'wrong-pw';

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('could not decrypt keystore (wrong password?)');
    expect(stderr).not.toContain('\n    at ');
  });

  it('fails clean when there is no fleet state (AC5)', async () => {
    const pw = 'pw7a';
    const { dir } = await buildEarningDir({ password: pw, withState: false });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('no fully-bootstrapped agent identity');
    expect(stderr).not.toContain('\n    at ');
  });

  it('fails clean when the only service is not operational (AC5)', async () => {
    const pw = 'pw7b';
    const { dir } = await buildEarningDir({ password: pw, step: 'awaiting_stake' });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('no fully-bootstrapped agent identity');
  });

  it('fails clean when safe_address is null (AC5)', async () => {
    const pw = 'pw7c';
    const { dir } = await buildEarningDir({ password: pw, safeAddress: null });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('no fully-bootstrapped agent identity');
  });

  it('fails clean when agent_id is null (AC5)', async () => {
    const pw = 'pw7d';
    const { dir } = await buildEarningDir({ password: pw, agentId: null });
    process.env['JINN_EARNING_DIR'] = dir;
    process.env['JINN_PASSWORD'] = pw;

    const { writer, out } = capture();
    const code = await runJinnLayerCli(['derive-env'], { writer });

    expect(code).toBe(1);
    expect(out()).toBe('');
    expect(stderr).toContain('no fully-bootstrapped agent identity');
  });
});
