import { describe, it, expect, vi } from 'vitest';
import {
  checkVerdictBackReference,
  checkVerificationRecord,
} from '../../../src/conformance/checks/verdict.js';
import type { ConformanceContext } from '../../../src/conformance/types.js';
import {
  buildGoodVerdictFixture,
  buildGoodRestorationFixture,
} from '../fixtures/good-envelope.js';

vi.mock('../../../src/adapters/mech/ipfs.js', () => ({
  uploadToIpfs: vi.fn(async () => 'bafy-mock-cid'),
  cidToDigestHex: vi.fn().mockReturnValue('0xdeadbeef00000000000000000000000000000000000000000000000000000000'),
  fetchFromIpfs: vi.fn(),
  fetchFromDigest: vi.fn(),
  digestHexToGatewayUrl: vi.fn(),
}));

// ─── checkVerdictBackReference ────────────────────────────────────────────────

describe('checkVerdictBackReference', () => {
  it('skips on solution-role envelope', async () => {
    const rfx = await buildGoodRestorationFixture();
    const ctx: ConformanceContext = {
      envelope: rfx.envelope,
      envelopeCid: rfx.envelopeCid,
      options: {},
    };
    const result = checkVerdictBackReference(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.back-ref');
  });

  it('passes when solutionEnvelope.sha256 matches fetched bytes', async () => {
    const vfx = await buildGoodVerdictFixture();
    const ctx: ConformanceContext = {
      envelope: vfx.envelope,
      envelopeCid: vfx.envelopeCid,
      solutionEnvelopeBytes: vfx.solutionEnvelopeBytes,
      options: {},
    };
    const result = checkVerdictBackReference(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.back-ref');
  });

  it('fails when sha256 does not match (tampered bytes)', async () => {
    const vfx = await buildGoodVerdictFixture();
    const tampered = new Uint8Array([...vfx.solutionEnvelopeBytes, 0x00]);
    const ctx: ConformanceContext = {
      envelope: vfx.envelope,
      envelopeCid: vfx.envelopeCid,
      solutionEnvelopeBytes: tampered,
      options: {},
    };
    const result = checkVerdictBackReference(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/sha256/i);
  });

  it('fails when solution bytes not provided (did not resolve)', async () => {
    const vfx = await buildGoodVerdictFixture();
    const ctx: ConformanceContext = {
      envelope: vfx.envelope,
      envelopeCid: vfx.envelopeCid,
      // no solutionEnvelopeBytes
      options: {},
    };
    const result = checkVerdictBackReference(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/resolve/i);
  });

  it('fails when payload.solutionEnvelope is missing', async () => {
    const vfx = await buildGoodVerdictFixture();
    const env = {
      ...vfx.envelope,
      payload: { ...vfx.envelope.payload as Record<string, unknown> },
    };
    delete (env.payload as Record<string, unknown>).solutionEnvelope;
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: vfx.envelopeCid,
      solutionEnvelopeBytes: vfx.solutionEnvelopeBytes,
      options: {},
    };
    const result = checkVerdictBackReference(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/missing/i);
  });

  it('fails when envelope is not loaded', () => {
    const ctx: ConformanceContext = { envelopeCid: 'bafy-test', options: {} };
    const result = checkVerdictBackReference(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/not loaded/);
  });
});

// ─── checkVerificationRecord ──────────────────────────────────────────────────

describe('checkVerificationRecord', () => {
  it('skips on solution-role envelope', async () => {
    const rfx = await buildGoodRestorationFixture();
    const ctx: ConformanceContext = {
      envelope: rfx.envelope,
      envelopeCid: rfx.envelopeCid,
      options: {},
    };
    const result = checkVerificationRecord(ctx);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.verification-record');
  });

  it('passes when verificationOfRestoration is present and valid', async () => {
    const vfx = await buildGoodVerdictFixture();
    const ctx: ConformanceContext = {
      envelope: vfx.envelope,
      envelopeCid: vfx.envelopeCid,
      options: {},
    };
    const result = checkVerificationRecord(ctx);
    expect(result.passed).toBe(true);
    expect(result.id).toBe('verdict.verification-record');
  });

  it('fails when verificationOfRestoration has empty checks array', async () => {
    const vfx = await buildGoodVerdictFixture();
    const payload = { ...vfx.envelope.payload as Record<string, unknown> };
    payload.verificationOfRestoration = {
      ...(payload.verificationOfRestoration as Record<string, unknown>),
      checks: [],
    };
    const env = { ...vfx.envelope, payload };
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: vfx.envelopeCid,
      options: {},
    };
    const result = checkVerificationRecord(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/checks/);
  });

  it('fails when overall is an invalid value', async () => {
    const vfx = await buildGoodVerdictFixture();
    const payload = { ...vfx.envelope.payload as Record<string, unknown> };
    payload.verificationOfRestoration = {
      ...(payload.verificationOfRestoration as Record<string, unknown>),
      overall: 'maybe',
    };
    const env = { ...vfx.envelope, payload };
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: vfx.envelopeCid,
      options: {},
    };
    const result = checkVerificationRecord(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/overall/);
  });

  it('fails when verificationOfRestoration is missing', async () => {
    const vfx = await buildGoodVerdictFixture();
    const payload = { ...vfx.envelope.payload as Record<string, unknown> };
    delete payload.verificationOfRestoration;
    const env = { ...vfx.envelope, payload };
    const ctx: ConformanceContext = {
      envelope: env as any,
      envelopeCid: vfx.envelopeCid,
      options: {},
    };
    const result = checkVerificationRecord(ctx);
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/missing/);
  });
});
