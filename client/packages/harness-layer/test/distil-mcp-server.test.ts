import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDistilMcpServer, runLocalDistil } from '../src/distil-mcp-server.js';

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

describe('local distil MCP server', () => {
  it('registers the trace and distill tools with descriptions', () => {
    const server = createDistilMcpServer();
    const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;

    expect(Object.keys(registered).sort()).toEqual([...EXPECTED_TOOLS].sort());
    for (const toolName of EXPECTED_TOOLS) {
      expect(registered[toolName]?.description?.length, `${toolName} should have a description`).toBeGreaterThan(0);
    }
  });

  it('runs confirmed distillation through jinn-layer distil with local/json flags', async () => {
    const child = new FakeChildProcess();
    const spawn = vi.fn(() => child as never);
    const resultPromise = runLocalDistil(
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
      'distil',
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
});
