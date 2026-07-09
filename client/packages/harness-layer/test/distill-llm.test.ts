import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import {
  createClaudeDistiller,
  createClaudeMetaDistiller,
  createCodexDistiller,
  createCodexMetaDistiller,
  DEFAULT_CODEX_MODEL,
  buildMetaDistillInput,
  type ChildLike,
  type SpawnLike,
} from '../src/distill-llm.js';
import { JINN_SKILL_DISTILL_PROMPT_V1, JINN_SKILL_META_DISTILL_PROMPT_V1 } from '../src/distill-prompt.js';
import type { DistillCluster } from '../src/distill.js';
import type { MetaCluster } from '../src/cluster.js';

/**
 * Fake `claude` child. The port pipes the built input on stdin and reads the
 * canned response on stdout, then completes on `exit`. We capture what was
 * written to stdin so a test can assert the prompt reached the process.
 */
function fakeChild(opts: { stdout: string; code?: number; stderr?: string }): ChildLike & { writes: string[] } {
  const emitter = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const writes: string[] = [];
  const child = {
    writes,
    stdin: {
      write(chunk: string) { writes.push(chunk); },
      end() {
        // Emit the canned output only once stdin is closed, mirroring `claude -p`.
        setImmediate(() => {
          if (opts.stderr) stderr.emit('data', Buffer.from(opts.stderr));
          stdout.emit('data', Buffer.from(opts.stdout));
          emitter.emit('exit', opts.code ?? 0, null);
        });
      },
    },
    stdout,
    stderr,
    on(event: string, listener: (...a: unknown[]) => void) { emitter.on(event, listener); },
  };
  return child as unknown as ChildLike & { writes: string[] };
}

function makeSpawn(child: ChildLike): { spawn: SpawnLike; calls: Array<{ command: string; args: readonly string[] }> } {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const spawn: SpawnLike = (command, args) => {
    calls.push({ command, args });
    return child;
  };
  return { spawn, calls };
}

const cluster: DistillCluster = {
  clusterId: 'c1',
  tier: 'pattern',
  evidenceRefs: ['bafyEv1'],
  instanceIds: ['flask__flask-1'],
  input: { note: 'apply .distinct() after the join' },
};

describe('createClaudeDistiller', () => {
  it('parses a strict JSON object from stdout into a DistillLLMOutput', async () => {
    const out = { name: 'orm-dedup', description: 'Use when a queryset dups.', body: '# Dedup\n\nUse .distinct().\n' };
    const child = fakeChild({ stdout: JSON.stringify(out) });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).resolves.toEqual(out);
  });

  it('extracts the JSON object even when wrapped in leading/trailing prose', async () => {
    const out = { name: 'retry-idempotently', description: 'Use when retrying a mutation.', body: 'body { with braces }' };
    const child = fakeChild({ stdout: `Here is the skill:\n${JSON.stringify(out)}\nHope that helps!` });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).resolves.toEqual(out);
  });

  it('sends the versioned distill prompt to the process on stdin', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await distill(cluster);
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain(JINN_SKILL_DISTILL_PROMPT_V1);
    // The cluster's tier surfaces as the MODE and its evidence is included.
    expect(sent).toContain('MODE = strategic-pattern');
    expect(sent).toContain('apply .distinct() after the join');
  });

  it('spawns `claude -p --model <model>` with the configured path + model', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn, calls } = makeSpawn(child);
    const distill = createClaudeDistiller({ claudePath: '/opt/claude', model: 'claude-sonnet-4-6', spawnImpl: spawn });

    await distill(cluster);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/opt/claude');
    expect(calls[0]!.args).toContain('-p');
    expect(calls[0]!.args).toContain('--model');
    expect(calls[0]!.args).toContain('claude-sonnet-4-6');
  });

  it('defaults to `claude` + the opus-class distiller model when unconfigured (§5, v0.5)', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn, calls } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await distill(cluster);
    expect(calls[0]!.command).toBe('claude');
    expect(calls[0]!.args).toContain('claude-opus-4-8');
  });

  it('keys the MODE off the cluster tier (lesson → failure-lesson)', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await distill({ ...cluster, tier: 'lesson' });
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain('MODE = failure-lesson');
  });

  it('keys the MODE off the cluster tier (contrastive → contrastive, §7 v0.5)', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await distill({ ...cluster, tier: 'contrastive' });
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain('MODE = contrastive');
  });

  it('throws when the model returns non-JSON', async () => {
    const child = fakeChild({ stdout: 'sorry, I could not produce a skill' });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).rejects.toThrow(/no JSON object/);
  });

  it('throws when the JSON is malformed', async () => {
    const child = fakeChild({ stdout: '{ "name": "n", "description": "d", ' });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).rejects.toThrow(/unterminated|not valid JSON/);
  });

  it('throws when a required field is missing', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd' }) });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).rejects.toThrow(/missing\/invalid field "body"/);
  });

  it('rejects when claude exits non-zero', async () => {
    const child = fakeChild({ stdout: '', code: 1, stderr: 'Not logged in' });
    const { spawn } = makeSpawn(child);
    const distill = createClaudeDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).rejects.toThrow(/exited with code 1/);
  });
});

describe('createCodexDistiller', () => {
  it('spawns `codex exec` with read-only sandbox, structured output schema, and the configured model', async () => {
    const out = { name: 'orm-dedup', description: 'Use when a queryset dups.', body: '# Dedup\n' };
    const child = fakeChild({ stdout: JSON.stringify(out) });
    const { spawn, calls } = makeSpawn(child);
    const distill = createCodexDistiller({ codexPath: '/opt/codex', model: 'gpt-5.4-mini', spawnImpl: spawn });

    await expect(distill(cluster)).resolves.toEqual(out);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('/opt/codex');
    const args = calls[0]!.args;
    expect(args.slice(0, 10)).toEqual([
      '--ask-for-approval',
      'never',
      'exec',
      '--model',
      'gpt-5.4-mini',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--output-schema',
      args[9],
    ]);
    expect(args[9]).toMatch(/jinn-codex-schema-/);
    expect(args[10]).toBe('-');
  });

  it('sends the versioned distill prompt to codex on stdin', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const distill = createCodexDistiller({ spawnImpl: spawn });

    await distill(cluster);
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain(JINN_SKILL_DISTILL_PROMPT_V1);
    expect(sent).toContain('MODE = strategic-pattern');
    expect(sent).toContain('apply .distinct() after the join');
  });

  it('defaults to `codex` + the quality Codex distiller model when unconfigured', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn, calls } = makeSpawn(child);
    const distill = createCodexDistiller({ spawnImpl: spawn });

    await distill(cluster);
    expect(calls[0]!.command).toBe('codex');
    expect(calls[0]!.args).toContain(DEFAULT_CODEX_MODEL);
  });

  it('reports stderr and stdout context when codex exits non-zero', async () => {
    const child = fakeChild({ stdout: 'partial output', code: 1, stderr: 'Not logged in' });
    const { spawn } = makeSpawn(child);
    const distill = createCodexDistiller({ spawnImpl: spawn });

    await expect(distill(cluster)).rejects.toThrow(/codex exited with code 1.*Not logged in.*partial output/s);
  });
});

const metaCluster: MetaCluster = {
  metaClusterId: 'cross-instance:failure-lesson',
  polarity: 'failure-lesson',
  gateTier: 'lesson',
  sources: [
    { id: 's1', name: 'a', description: 'da', body: 'body-a-distinct', evidenceRefs: ['ev-a'], instanceIds: ['a'] },
    { id: 's2', name: 'b', description: 'db', body: 'body-b-distinct', evidenceRefs: ['ev-b'], instanceIds: ['b'] },
  ],
};

describe('createClaudeMetaDistiller', () => {
  it('parses a { name, description, body, supports } object from stdout', async () => {
    const out = { name: 'xi', description: 'Use when … Not for: …', body: 'b', supports: ['s1', 's2'] };
    const child = fakeChild({ stdout: JSON.stringify(out) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await expect(meta(metaCluster)).resolves.toEqual(out);
  });

  it('sends the meta prompt, the POLARITY hint, and the labelled sources on stdin', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b', supports: ['s1', 's2'] }) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await meta(metaCluster);
    const sent = (child as unknown as { writes: string[] }).writes.join('');
    expect(sent).toContain(JINN_SKILL_META_DISTILL_PROMPT_V1);
    expect(sent).toContain('POLARITY = failure-lesson');
    expect(sent).toContain('s1');
    expect(sent).toContain('body-a-distinct');
  });

  it('throws when supports is missing or not an array of strings', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const meta = createClaudeMetaDistiller({ spawnImpl: spawn });
    await expect(meta(metaCluster)).rejects.toThrow(/supports/);
  });

  it('buildMetaDistillInput labels each source and states the JSON contract', () => {
    const input = buildMetaDistillInput(JINN_SKILL_META_DISTILL_PROMPT_V1, metaCluster);
    expect(input).toContain('POLARITY = failure-lesson');
    expect(input).toContain('s1');
    expect(input).toContain('s2');
    expect(input).toContain('"supports"');
  });
});

describe('createCodexMetaDistiller', () => {
  it('parses and validates a meta-distill object with supports', async () => {
    const out = { name: 'xi', description: 'Use when … Not for: …', body: 'b', supports: ['s1', 's2'] };
    const child = fakeChild({ stdout: JSON.stringify(out) });
    const { spawn } = makeSpawn(child);
    const meta = createCodexMetaDistiller({ spawnImpl: spawn });

    await expect(meta(metaCluster)).resolves.toEqual(out);
  });

  it('throws when codex meta output omits supports', async () => {
    const child = fakeChild({ stdout: JSON.stringify({ name: 'n', description: 'd', body: 'b' }) });
    const { spawn } = makeSpawn(child);
    const meta = createCodexMetaDistiller({ spawnImpl: spawn });

    await expect(meta(metaCluster)).rejects.toThrow(/supports/);
  });
});
