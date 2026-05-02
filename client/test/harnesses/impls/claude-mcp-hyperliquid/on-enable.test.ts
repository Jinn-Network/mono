import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ClaudeMcpHyperliquidImpl } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/index.js';
import { loadApiWalletState } from '../../../../src/harnesses/impls/claude-mcp-hyperliquid/api-wallet.js';

describe('ClaudeMcpHyperliquidImpl.onEnable + isReady state machine', () => {
  let implStateDir: string;

  beforeEach(() => {
    implStateDir = mkdtempSync(join(tmpdir(), 'jinn-hl-enable-'));
  });

  afterEach(() => rmSync(implStateDir, { recursive: true, force: true }));

  function makeImpl(): ClaudeMcpHyperliquidImpl {
    return new ClaudeMcpHyperliquidImpl({ implStateDir });
  }

  it('isReady returns not-ready when api-wallet absent', async () => {
    const impl = makeImpl();
    const status = await impl.isReady();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/api-wallet not provisioned/);
  });

  it('onEnable without --hl-master returns missing_args', async () => {
    const impl = makeImpl();
    const result = await impl.onEnable({ args: {}, runtimePlugins: [] });
    expect(result.status).toBe('missing_args');
  });

  it('onEnable with --hl-master generates wallet and returns waiting_for_external_action', async () => {
    const impl = makeImpl();
    const result = await impl.onEnable({ args: { 'hl-master': '0xABC' }, runtimePlugins: [] });
    expect(result.status).toBe('waiting_for_external_action');
    if (result.status !== 'waiting_for_external_action') throw new Error('unreachable');
    expect(result.details?.['apiWalletAddress']).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(result.details?.['masterAddress']).toBe('0xABC');
    expect(result.nextInvocation.cli).toContain('--confirm-approved');

    // Wallet persisted as not-approved with master recorded.
    const persisted = loadApiWalletState(implStateDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.approved).toBe(false);
    expect(persisted!.masterAddress).toBe('0xABC');
  });

  it('re-invoking onEnable without --confirm-approved stays in waiting state (no regen)', async () => {
    const impl = makeImpl();
    const first = await impl.onEnable({ args: { 'hl-master': '0xABC' }, runtimePlugins: [] });
    if (first.status !== 'waiting_for_external_action') throw new Error('unreachable');
    const firstAddress = first.details?.['apiWalletAddress'];

    const second = await impl.onEnable({ args: {}, runtimePlugins: [] });
    if (second.status !== 'waiting_for_external_action') throw new Error('unreachable');
    expect(second.details?.['apiWalletAddress']).toBe(firstAddress);
  });

  it('onEnable with --confirm-approved flips approved and returns ready', async () => {
    const impl = makeImpl();
    await impl.onEnable({ args: { 'hl-master': '0xABC' }, runtimePlugins: [] });
    const result = await impl.onEnable({ args: { 'confirm-approved': '' }, runtimePlugins: [] });
    expect(result.status).toBe('ready');

    const persisted = loadApiWalletState(implStateDir);
    expect(persisted!.approved).toBe(true);
    expect(persisted!.masterAddress).toBe('0xABC');

    const status = await impl.isReady();
    expect(status.ready).toBe(true);
  });

  it('onEnable on an already-ready impl is a no-op returning ready', async () => {
    const impl = makeImpl();
    await impl.onEnable({ args: { 'hl-master': '0xABC' }, runtimePlugins: [] });
    await impl.onEnable({ args: { 'confirm-approved': '' }, runtimePlugins: [] });
    const repeat = await impl.onEnable({ args: { 'hl-master': '0xOTHER' }, runtimePlugins: [] });
    expect(repeat.status).toBe('ready');

    // Master not overwritten by idempotent no-op.
    const persisted = loadApiWalletState(implStateDir);
    expect(persisted!.masterAddress).toBe('0xABC');
  });

  it('isReady surfaces missing masterAddress as not-ready with nextStep', async () => {
    // Set up a wallet file with approved:true but no master (simulate an
    // old hand-crafted file).
    const impl = makeImpl();
    await impl.onEnable({ args: { 'hl-master': '0xABC' }, runtimePlugins: [] });
    // Manually rewrite to strip masterAddress but keep approved.
    const persisted = loadApiWalletState(implStateDir)!;
    const { masterAddress: _m, ...rest } = persisted;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(implStateDir, 'api-wallet.json'),
      JSON.stringify({ ...rest, approved: true }),
      'utf-8',
    );

    const status = await impl.isReady();
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/master address not recorded/i);
  });
});
