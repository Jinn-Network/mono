import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { createClaudeDistiller, type ChildLike, type SpawnLike } from '../src/distill-llm.js';
import { JINN_SKILL_DISTILL_PROMPT_V1 } from '../src/distill-prompt.js';
import type { DistillCluster } from '../src/distill.js';

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
