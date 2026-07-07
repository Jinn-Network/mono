import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('harness getAuthSource descriptors (#564)', () => {
  it('HermesHarness declares its ~/.hermes/.env OPENROUTER_API_KEY file source', async () => {
    const { HermesHarness } = await import('../../src/harnesses/impls/hermes-agent/harness.js');
    const harness = new HermesHarness({
      adapter: { name: 'hermes-agent', runTask: async () => {} } as never,
    });
    const src = await harness.getAuthSource!();
    expect(src.sourceKind).toBe('file');
    if (src.sourceKind !== 'file') throw new Error('unreachable');
    expect(src.envKey).toBe('OPENROUTER_API_KEY');
    expect(src.docAnchor).toBe('hermes-agent');
    expect(src.absolutePath).toBe(join(homedir(), '.hermes', '.env'));
    expect(src.sourcePath).toMatch(/\.hermes\/\.env$/);
  });

  it('HermesHarness honours HERMES_HOME for the .env path', async () => {
    const prev = process.env['HERMES_HOME'];
    process.env['HERMES_HOME'] = '/tmp/custom-hermes';
    try {
      const { HermesHarness } = await import('../../src/harnesses/impls/hermes-agent/harness.js');
      const harness = new HermesHarness({
        adapter: { name: 'hermes-agent', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      if (src.sourceKind !== 'file') throw new Error('unreachable');
      expect(src.absolutePath).toBe('/tmp/custom-hermes/.env');
    } finally {
      if (prev === undefined) delete process.env['HERMES_HOME'];
      else process.env['HERMES_HOME'] = prev;
    }
  });

  it('LearnerHarness(claude-code) declares a session source', async () => {
    const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
    const harness = new LearnerHarness({
      name: 'claude-code',
      adapter: { name: 'claude-code', runTask: async () => {} } as never,
    });
    const src = await harness.getAuthSource!();
    expect(src.sourceKind).toBe('session');
    expect(src.docAnchor).toBe('claude-code');
  });

  it('LearnerHarness(codex) declares the ~/.codex/auth.json file source', async () => {
    const prevHome = process.env['CODEX_HOME'];
    const prevKey = process.env['OPENAI_API_KEY'];
    delete process.env['CODEX_HOME'];
    delete process.env['OPENAI_API_KEY'];
    try {
      const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
      const harness = new LearnerHarness({
        name: 'codex',
        adapter: { name: 'codex', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      expect(src.sourceKind).toBe('file');
      if (src.sourceKind !== 'file') throw new Error('unreachable');
      expect(src.docAnchor).toBe('codex');
      expect(src.absolutePath).toBe(join(homedir(), '.codex', 'auth.json'));
      expect(src.credentialIsJson).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env['CODEX_HOME']; else process.env['CODEX_HOME'] = prevHome;
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });

  it('LearnerHarness(codex) prefers OPENAI_API_KEY env when set', async () => {
    const prevKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-proj-fixture';
    try {
      const { LearnerHarness } = await import('../../src/harnesses/impls/learner/harness.js');
      const harness = new LearnerHarness({
        name: 'codex',
        adapter: { name: 'codex', runTask: async () => {} } as never,
      });
      const src = await harness.getAuthSource!();
      expect(src.sourceKind).toBe('env');
      if (src.sourceKind !== 'env') throw new Error('unreachable');
      expect(src.envKey).toBe('OPENAI_API_KEY');
      expect(src.docAnchor).toBe('codex');
    } finally {
      if (prevKey === undefined) delete process.env['OPENAI_API_KEY']; else process.env['OPENAI_API_KEY'] = prevKey;
    }
  });
});
