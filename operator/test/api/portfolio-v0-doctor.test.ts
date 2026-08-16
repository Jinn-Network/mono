import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  checkImplStateDir,
  checkHlApiWallet,
  runPortfolioV0DoctorChecks,
} from '../../src/api/portfolio-v0-doctor.js';
import type { ApiWalletState } from '../../src/harnesses/impls/claude-mcp-hyperliquid/api-wallet.js';

let tmpBase: string;

beforeEach(() => {
  tmpBase = join(tmpdir(), `jinn-doctor-test-${randomUUID()}`);
  mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  rmSync(tmpBase, { recursive: true, force: true });
});

// ── checkImplStateDir ──────────────────────────────────────────────────────────

describe('checkImplStateDir', () => {
  it('fails when implStateDir is undefined', () => {
    const result = checkImplStateDir(undefined);
    expect(result.ok).toBe(false);
    expect(result.name).toBe('portfolio_impl_state_dir');
    expect(result.detail).toContain('not configured');
  });

  it('fails when directory does not exist', () => {
    const result = checkImplStateDir(join(tmpBase, 'nonexistent'));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('does not exist');
  });

  it('passes when directory exists and is readable', () => {
    const dir = join(tmpBase, 'impl-state');
    mkdirSync(dir, { recursive: true });
    const result = checkImplStateDir(dir);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('present and readable');
  });
});

// ── checkHlApiWallet ──────────────────────────────────────────────────────────

describe('checkHlApiWallet', () => {
  it('fails when implStateDir is undefined', () => {
    const result = checkHlApiWallet(undefined);
    expect(result.ok).toBe(false);
    expect(result.name).toBe('hl_api_wallet');
  });

  it('fails when api-wallet.json does not exist', () => {
    const result = checkHlApiWallet(tmpBase);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('api-wallet.json not found');
  });

  it('fails when api-wallet.json is corrupt JSON', () => {
    writeFileSync(join(tmpBase, 'api-wallet.json'), 'not-json', { mode: 0o600 });
    const result = checkHlApiWallet(tmpBase);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('could not be parsed');
  });

  it('fails (with address) when wallet exists but not approved', () => {
    const state: ApiWalletState = {
      privateKey: '0x' + 'a'.repeat(64),
      address: '0x1234567890123456789012345678901234567890',
      approved: false,
      createdAt: Date.now(),
    };
    writeFileSync(join(tmpBase, 'api-wallet.json'), JSON.stringify(state), { mode: 0o600 });
    const result = checkHlApiWallet(tmpBase);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('not approved');
    expect(result.detail).toContain(state.address);
    expect(result.remedy).toContain('HL');
  });

  it('passes when wallet exists and is approved', () => {
    const state: ApiWalletState = {
      privateKey: '0x' + 'b'.repeat(64),
      address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      approved: true,
      createdAt: Date.now(),
      approvedAt: Date.now(),
    };
    writeFileSync(join(tmpBase, 'api-wallet.json'), JSON.stringify(state), { mode: 0o600 });
    const result = checkHlApiWallet(tmpBase);
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('approved');
    expect(result.detail).toContain(state.address);
  });
});

// ── runPortfolioV0DoctorChecks ─────────────────────────────────────────────────

describe('runPortfolioV0DoctorChecks', () => {
  it('returns two checks', () => {
    const results = runPortfolioV0DoctorChecks(undefined);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain('portfolio_impl_state_dir');
    expect(results.map((r) => r.name)).toContain('hl_api_wallet');
  });

  it('all pass when directory exists and wallet is approved', () => {
    const dir = join(tmpBase, 'hl-impl');
    mkdirSync(dir, { recursive: true });
    const state: ApiWalletState = {
      privateKey: '0x' + 'c'.repeat(64),
      address: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      approved: true,
      createdAt: Date.now(),
    };
    writeFileSync(join(dir, 'api-wallet.json'), JSON.stringify(state), { mode: 0o600 });

    const results = runPortfolioV0DoctorChecks(dir);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
