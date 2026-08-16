import { describe, it, expect } from 'vitest';
import {
  checkSeccompPolicy,
  checkNamespacePolicy,
  checkTlsTranscriptCapture,
} from '../../../src/conformance/checks/source-runtime.js';

/**
 * Layer 2 runtime stubs — V1 returns skipped for all three checks.
 *
 * These stubs are V2 TEE integration plug-in points. Their presence in the
 * harness proves the conformance suite structure accommodates runtime
 * enforcement without refactor when V2 ships.
 */

describe('checkSeccompPolicy', () => {
  it('returns skipped: true', () => {
    const result = checkSeccompPolicy({} as any);
    expect(result.skipped).toBe(true);
  });

  it('has id runtime.seccomp', () => {
    const result = checkSeccompPolicy({} as any);
    expect(result.id).toBe('runtime.seccomp');
  });

  it('has layer 2', () => {
    const result = checkSeccompPolicy({} as any);
    expect(result.layer).toBe(2);
  });

  it('has a detail note referencing V2', () => {
    const result = checkSeccompPolicy({} as any);
    expect(result.detail).toMatch(/V2/);
  });

  it('has passed: true (skipped checks count as passing)', () => {
    const result = checkSeccompPolicy({} as any);
    expect(result.passed).toBe(true);
  });
});

describe('checkNamespacePolicy', () => {
  it('returns skipped: true', () => {
    const result = checkNamespacePolicy({} as any);
    expect(result.skipped).toBe(true);
  });

  it('has id runtime.namespace', () => {
    const result = checkNamespacePolicy({} as any);
    expect(result.id).toBe('runtime.namespace');
  });

  it('has layer 2', () => {
    const result = checkNamespacePolicy({} as any);
    expect(result.layer).toBe(2);
  });

  it('has a detail note referencing V2', () => {
    const result = checkNamespacePolicy({} as any);
    expect(result.detail).toMatch(/V2/);
  });

  it('has passed: true (skipped checks count as passing)', () => {
    const result = checkNamespacePolicy({} as any);
    expect(result.passed).toBe(true);
  });
});

describe('checkTlsTranscriptCapture', () => {
  it('returns skipped: true', () => {
    const result = checkTlsTranscriptCapture({} as any);
    expect(result.skipped).toBe(true);
  });

  it('has id runtime.tls-transcript', () => {
    const result = checkTlsTranscriptCapture({} as any);
    expect(result.id).toBe('runtime.tls-transcript');
  });

  it('has layer 2', () => {
    const result = checkTlsTranscriptCapture({} as any);
    expect(result.layer).toBe(2);
  });

  it('has a detail note referencing V2', () => {
    const result = checkTlsTranscriptCapture({} as any);
    expect(result.detail).toMatch(/V2/);
  });

  it('has passed: true (skipped checks count as passing)', () => {
    const result = checkTlsTranscriptCapture({} as any);
    expect(result.passed).toBe(true);
  });
});
