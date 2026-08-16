import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCredentialId } from '../../src/spend/credential.js';

describe('resolveCredentialId', () => {
  let home: string;

  beforeEach(() => {
    // Isolated empty home for each test so disk-OAuth probes start blank.
    home = mkdtempSync(join(tmpdir(), 'cred-test-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  describe('claude-code', () => {
    it('prefers CLAUDE_CODE_OAUTH_TOKEN when both env vars are set (preserves PR #345 precedence)', () => {
      expect(resolveCredentialId('claude-code', { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' }, home))
        .toBe('anthropic:subscription');
    });

    it('treats CLAUDE_CODE_OAUTH_TOKEN as a subscription marker', () => {
      expect(resolveCredentialId('claude-code', { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }, home))
        .toBe('anthropic:subscription');
    });

    it('treats ANTHROPIC_API_KEY alone as an api-key path', () => {
      expect(resolveCredentialId('claude-code', { ANTHROPIC_API_KEY: 'sk-ant' }, home))
        .toBe('anthropic:api-key');
    });

    it('treats ~/.claude/ presence as a subscription marker (#901)', () => {
      mkdirSync(join(home, '.claude'));
      expect(resolveCredentialId('claude-code', {}, home)).toBe('anthropic:subscription');
    });

    it('env vars still win over the disk probe', () => {
      mkdirSync(join(home, '.claude'));
      expect(resolveCredentialId('claude-code', { ANTHROPIC_API_KEY: 'sk-ant' }, home))
        .toBe('anthropic:api-key');
    });

    it('returns null when no env var AND no ~/.claude/ on disk', () => {
      expect(resolveCredentialId('claude-code', {}, home)).toBeNull();
    });
  });

  describe('codex', () => {
    it('prefers OPENAI_API_KEY (most explicit)', () => {
      expect(resolveCredentialId('codex', { OPENAI_API_KEY: 'sk-x' }, home)).toBe('openai:api-key');
    });

    it('treats ~/.codex/auth.json as a subscription marker (#901)', () => {
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'auth.json'), '{}');
      expect(resolveCredentialId('codex', {}, home)).toBe('openai:subscription');
    });

    it('returns null when no env var AND no ~/.codex/auth.json on disk', () => {
      expect(resolveCredentialId('codex', {}, home)).toBeNull();
    });
  });

  describe('hermes-agent', () => {
    it('keys on the configured provider', () => {
      expect(resolveCredentialId('hermes-agent', { JINN_HERMES_PROVIDER: 'openrouter' }, home))
        .toBe('openrouter:api-key');
    });

    it('defaults to hermes:api-key when JINN_HERMES_PROVIDER is unset', () => {
      expect(resolveCredentialId('hermes-agent', {}, home)).toBe('hermes:api-key');
    });
  });

  it('returns null for a harness with no LLM credential', () => {
    expect(resolveCredentialId('prediction-v1-baseline', {}, home)).toBeNull();
    expect(resolveCredentialId(undefined, {}, home)).toBeNull();
  });
});
