import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDistillMcpServer, runLocalDistill } from '../src/distill-mcp-server.js';

const EXPECTED_TOOLS = [
  'distill_trace_search',
  'distill_trace_read',
  'distill_trace_cluster',
  'distill_local',
  'distill_feedback_record',
] as const;

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

describe('local distill MCP server', () => {
  it('registers the trace and distill tools with descriptions', () => {
    const server = createDistillMcpServer();
    const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;

    expect(Object.keys(registered).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const toolName of EXPECTED_TOOLS) {
      expect(registered[toolName]?.description?.length, `${toolName} should have a description`).toBeGreaterThan(0);
    }
  });

  it('runs confirmed distillation through jinn-layer distill with local/json flags', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child as never);
    const resultPromise = runLocalDistill(
      {
        capturesDir: '/captures',
        out: '/out',
        limit: 10,
        install: 'all',
        resume: true,
        distiller: 'codex',
        distillerModel: 'gpt-5.1',
      },
      { spawn, env: { JINN_LAYER_BIN: '/bin/jinn-layer' } },
    );

    child.stdout.emit('data', '{"distilled":{"published":[]}}\n');
    child.stderr.emit('data', 'note\n');
    child.emit('close', 0);

    const result = await resultPromise;
    const body = JSON.parse(result.content[0]!.text) as { command: string[]; exitCode: number; stdout: string; stderr: string };

    expect(spawn).toHaveBeenCalledWith('/bin/jinn-layer', [
      'distill',
      '--where',
      'local',
      '--json',
      '--captures',
      '/captures',
      '--out',
      '/out',
      '--limit',
      '10',
      '--install',
      'all',
      '--resume',
      '--distiller',
      'codex',
      '--distiller-model',
      'gpt-5.1',
    ], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('"distilled"');
    expect(body.stderr).toBe('note\n');
    expect(result.isError).toBeUndefined();
  });

  it('passes the canonical episode store without enabling the legacy capture reader', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child as never);
    const resultPromise = runLocalDistill(
      { episodesDir: '/episodes' },
      { spawn, env: { JINN_LAYER_BIN: '/bin/jinn-layer' } },
    );

    child.emit('close', 0);
    await resultPromise;

    expect(spawn).toHaveBeenCalledWith('/bin/jinn-layer', [
      'distill',
      '--where',
      'local',
      '--json',
      '--episodes',
      '/episodes',
    ], expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }));
  });

  it.each([
    {
      name: 'environment override',
      env: { JINN_LAYER_BIN: 'C:\\untrusted\\jinn-layer.cmd' },
    },
    {
      name: 'bare PATH fallback',
      env: {},
    },
  ])('fails closed instead of using a Windows $name when the co-installed CLI is absent', async ({ env }) => {
    const spawn = vi.fn(() => {
      throw new Error('spawn must not be called');
    });

    await expect(runLocalDistill(
      { capturesDir: 'C:\\captures' },
      { spawn, env, platform: 'win32' },
    )).rejects.toThrow(/co-installed.*jinn-layer/i);

    expect(spawn).not.toHaveBeenCalled();
  });
});
