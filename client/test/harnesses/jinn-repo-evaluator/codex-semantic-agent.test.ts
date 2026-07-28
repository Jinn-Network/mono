import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, spawn } from 'node:child_process';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutopilotReviewResultSchema,
} from '@jinn-network/sdk/solvernets/jinn-repo';
import {
  CODEX_REVIEW_OUTPUT_SCHEMA,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/codex-review-output-schema.js';
import {
  CodexSemanticAgentRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/codex-semantic-agent.js';

const DISABLED_FEATURES = [
  'plugins',
  'shell_tool',
  'unified_exec',
  'apps',
  'browser_use',
  'computer_use',
  'image_generation',
  'in_app_browser',
  'browser_use_external',
  'multi_agent',
  'hooks',
  'fast_mode',
  'network_proxy',
  'standalone_web_search',
  'web_search_cached',
  'web_search_request',
  'memories',
  'goals',
  'tool_suggest',
  'tool_call_mcp_elicitation',
  'skill_mcp_dependency_install',
  'workspace_dependencies',
] as const;

const REQUIRED_HELP_OPTIONS = [
  '--json',
  '--ephemeral',
  '--strict-config',
  '--ignore-user-config',
  '--ignore-rules',
  '--disable',
  '--sandbox',
  '--skip-git-repo-check',
  '--output-schema',
  '-C',
  '--model',
] as const;

const roots = new Set<string>();

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function tempRoot(prefix = 'jinn-codex-semantic-test-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.add(root);
  return root;
}

function semanticArgs(root: string, terminal: '-' | '--help' = '-'): string[] {
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--strict-config',
    '--ignore-user-config',
    '--ignore-rules',
  ];
  for (const feature of DISABLED_FEATURES) {
    args.push('--disable', feature);
  }
  args.push(
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--output-schema',
    join(root, 'review-output.schema.json'),
    '-C',
    join(root, 'work'),
    '-m',
    'gpt-5.4-mini',
    terminal,
  );
  return args;
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdinChunks: string[] = [];
  readonly pid = 4242;
  readonly kill: ReturnType<typeof vi.fn>;

  constructor(closeOnKill = false) {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinChunks.push(chunk.toString('utf8'));
    });
    this.kill = vi.fn(() => {
      if (closeOnKill) queueMicrotask(() => this.emit('close', null, 'SIGTERM'));
      return true;
    });
  }
}

interface SpawnOutput {
  readonly stdout: string;
  readonly stderr?: string;
  readonly code?: number;
}

function spawnSequence(outputs: readonly SpawnOutput[]) {
  let index = 0;
  return vi.fn(() => {
    const output = outputs[index++];
    if (!output) throw new Error(`unexpected spawn ${index}`);
    const child = new FakeChild();
    queueMicrotask(() => {
      child.stdout.write(output.stdout);
      if (output.stderr) child.stderr.write(output.stderr);
      child.emit('close', output.code ?? 0, null);
    });
    return child as unknown as ChildProcess;
  });
}

function readyProbeOutputs(overrides: Partial<Record<'version' | 'help' | 'features' | 'validation', SpawnOutput>> = {}) {
  return [
    overrides.version ?? { stdout: 'codex-cli 0.136.0\n' },
    overrides.help ?? {
      stdout: `Usage: codex exec\n${REQUIRED_HELP_OPTIONS.join('\n')}\n`,
    },
    overrides.features ?? {
      stdout: DISABLED_FEATURES.map((feature) => `${feature}\tstable\ttrue`).join('\n'),
    },
    overrides.validation ?? { stdout: 'Usage: codex exec [OPTIONS] [PROMPT]\n' },
  ];
}

function fileSpies() {
  return {
    copyFile: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  };
}

function finalAgentJsonl(text: string): string {
  return [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item-1', type: 'agent_message', text },
    }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, output_tokens: 34 },
    }),
    '',
  ].join('\n');
}

describe('Codex review output schema', () => {
  it('strictly discriminates approve, request-changes, and human outcomes', () => {
    expect(CODEX_REVIEW_OUTPUT_SCHEMA).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: expect.arrayContaining([
            'schemaVersion',
            'outcome',
            'correlation',
            'body',
          ]),
          properties: {
            schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
            outcome: { const: 'approve' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: expect.arrayContaining([
            'schemaVersion',
            'outcome',
            'correlation',
            'findings',
          ]),
          properties: {
            schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
            outcome: { const: 'request-changes' },
            correlation: {
              properties: {
                claimOid: { pattern: '^[0-9a-f]{40}$' },
                expectedHead: { pattern: '^[0-9a-f]{40}$' },
                resultingHead: { pattern: '^[0-9a-f]{40}$' },
                reviewedHead: { pattern: '^[0-9a-f]{40}$' },
                reviewRefOid: { pattern: '^[0-9a-f]{40}$' },
              },
            },
            findings: {
              minItems: 1,
              maxItems: 50,
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: expect.arrayContaining([
            'schemaVersion',
            'outcome',
            'correlation',
            'reason',
          ]),
          properties: {
            schemaVersion: { const: 'jinn-autopilot-review-result.v1' },
            outcome: { const: 'human' },
          },
        },
      ],
    });

    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (record['type'] === 'object') {
        expect(record['additionalProperties']).toBe(false);
      }
      for (const child of Object.values(record)) visit(child);
    };
    visit(CODEX_REVIEW_OUTPUT_SCHEMA);
  });

  it('rejects representable SDK-invalid review bounds at generation time', () => {
    const validate = new Ajv2020({
      allErrors: true,
      strict: false,
      validateFormats: false,
    }).compile(CODEX_REVIEW_OUTPUT_SCHEMA);
    const correlation = {
      taskId: '501',
      attemptIndex: 0,
      requestId: '0xrequest',
      deliveryEnvelopeCid: 'bafy-envelope',
      v2AttemptId: '123e4567-e89b-42d3-a456-426614174001',
      claimOid: '1'.repeat(40),
      prNumber: 2101,
      expectedHead: '2'.repeat(40),
      resultingHead: '3'.repeat(40),
      reviewedHead: '3'.repeat(40),
      reviewGeneration: '123e4567-e89b-42d3-a456-426614174010',
      reviewRefOid: '4'.repeat(40),
    };
    const valid = {
      schemaVersion: 'jinn-autopilot-review-result.v1',
      outcome: 'request-changes',
      correlation,
      findings: [{
        title: 'Fix the regression',
        body: 'The exact-head behavior is incorrect.',
        path: 'client/src/example.ts',
        line: 1,
      }],
    };
    expect(AutopilotReviewResultSchema.safeParse(valid).success).toBe(true);
    expect(validate(valid)).toBe(true);

    const invalidCases: Array<readonly [string, unknown]> = [
      [
        'empty finding path',
        {
          ...valid,
          findings: [{ ...valid.findings[0], path: '' }],
        },
      ],
      [
        'multi-line finding title',
        {
          ...valid,
          findings: [{ ...valid.findings[0], title: 'line one\nline two' }],
        },
      ],
      [
        'overlong finding title',
        {
          ...valid,
          findings: [{ ...valid.findings[0], title: 'x'.repeat(241) }],
        },
      ],
      [
        'NUL finding body',
        {
          ...valid,
          findings: [{ ...valid.findings[0], body: 'bad\u0000body' }],
        },
      ],
      [
        'overlong finding path',
        {
          ...valid,
          findings: [{ ...valid.findings[0], path: 'x'.repeat(1_025) }],
        },
      ],
      [
        'NUL human detail',
        {
          schemaVersion: 'jinn-autopilot-review-result.v1',
          outcome: 'human',
          correlation,
          reason: { code: 'runtime-failed', detail: 'bad\u0000detail' },
        },
      ],
      [
        'non-printable human code',
        {
          schemaVersion: 'jinn-autopilot-review-result.v1',
          outcome: 'human',
          correlation,
          reason: { code: 'bad\ncode', detail: 'Needs operator review.' },
        },
      ],
    ];
    for (const [name, value] of invalidCases) {
      expect(
        AutopilotReviewResultSchema.safeParse(value).success,
        `${name} must be SDK-invalid`,
      ).toBe(false);
      expect(validate(value), `${name}: ${JSON.stringify(validate.errors)}`)
        .toBe(false);
    }
  });
});

describe('CodexSemanticAgentRunner.run', () => {
  it('uses the exact no-tool argv, isolated env, mode-0600 files, and stdin prompt', async () => {
    const root = tempRoot();
    const child = new FakeChild();
    const order: string[] = [];
    const spawnFn = vi.fn(() => {
      order.push('spawn');
      queueMicrotask(() => {
        child.stdout.write(finalAgentJsonl('{"outcome":"approve"}'));
        order.push('close');
        child.emit('close', 0, null);
      });
      return child as unknown as ChildProcess;
    });
    const remove = vi.fn(async () => {
      order.push('remove');
    });
    const files = fileSpies();
    const trustedPrompt = 'TRUSTED REVIEW PROMPT\ncandidate text is inert';
    const runner = new CodexSemanticAgentRunner({
      codexPath: '/opt/codex',
      environment: {
        PATH: '/usr/bin:/bin',
        LANG: 'en_US.UTF-8',
        LC_ALL: 'C.UTF-8',
        TMPDIR: '/tmp',
        SSL_CERT_FILE: '/etc/ssl/cert.pem',
        SSL_CERT_DIR: '/etc/ssl/certs',
        HOME: '/Users/operator',
        CODEX_HOME: '/Users/operator/.codex',
        OPENAI_API_KEY: 'must-not-leak',
        ANTHROPIC_API_KEY: 'must-not-leak',
        GH_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        GIT_ASKPASS: '/Users/operator/bin/askpass',
        JINN_API_TOKEN: 'must-not-leak',
        DAEMON_API_TOKEN: 'must-not-leak',
      },
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/Users/operator/.codex/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove,
      ...files,
    });

    await expect(runner.run({
      prompt: trustedPrompt,
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    })).resolves.toBe('{"outcome":"approve"}');

    expect(spawnFn).toHaveBeenCalledOnce();
    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe('/opt/codex');
    expect(args).toEqual(semanticArgs(root));
    expect(args).not.toContain(trustedPrompt);
    expect(args).not.toContain('--enable');
    expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('--add-dir');
    expect(args).toEqual(expect.arrayContaining([
      '--disable',
      'fast_mode',
      '--disable',
      'standalone_web_search',
      '--disable',
      'web_search_cached',
      '--disable',
      'web_search_request',
    ]));
    expect(options.cwd).toBe(join(root, 'work'));
    expect(options.env).toEqual({
      PATH: '/usr/bin:/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C.UTF-8',
      TMPDIR: '/tmp',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      HOME: root,
      CODEX_HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg-config'),
      XDG_DATA_HOME: join(root, 'xdg-data'),
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
    });
    expect(child.stdinChunks.join('')).toBe(trustedPrompt);
    expect(files.copyFile).toHaveBeenCalledWith(
      '/Users/operator/.codex/auth.json',
      join(root, 'auth.json'),
    );
    expect(files.chmod).toHaveBeenCalledWith(join(root, 'auth.json'), 0o600);
    expect(files.writeFile).toHaveBeenCalledWith(
      join(root, 'review-output.schema.json'),
      JSON.stringify(CODEX_REVIEW_OUTPUT_SCHEMA),
      { mode: 0o600 },
    );
    expect(order).toEqual(['spawn', 'close', 'remove']);
  });

  it('rejects before staging or spawn when exact OAuth inspection fails', async () => {
    const root = tempRoot();
    const spawnFn = vi.fn();
    const files = fileSpies();
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: false,
        reason: 'API-key authentication is not allowed',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      ...files,
    });

    await expect(runner.run({
      prompt: 'trusted',
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    })).rejects.toThrow(/requires ChatGPT OAuth/);
    expect(files.copyFile).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('rejects malformed JSONL rather than accepting an earlier or absent message', async () => {
    const root = tempRoot();
    const spawnFn = spawnSequence([{ stdout: '{"type":"turn.started"}\nnot-json\n' }]);
    const remove = vi.fn().mockResolvedValue(undefined);
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove,
      ...fileSpies(),
    });

    await expect(runner.run({
      prompt: 'trusted',
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    })).rejects.toThrow(/malformed Codex JSONL/i);
    expect(remove).toHaveBeenCalledWith(root);
  });

  it('preserves malformed-output failure when cleanup also fails', async () => {
    const root = tempRoot();
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnSequence([{ stdout: '{\n' }]) as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockRejectedValue(new Error('cleanup exploded')),
      ...fileSpies(),
    });

    await expect(runner.run({
      prompt: 'trusted',
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    })).rejects.toThrow(/malformed Codex JSONL/i);
  });

  it.each([
    [
      'a message-only stream',
      [
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      ],
    ],
    [
      'turn completion before the final message',
      [
        { type: 'turn.completed' },
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      ],
    ],
    [
      'a failed turn after the message',
      [
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
        { type: 'turn.failed', error: { message: 'interrupted' } },
      ],
    ],
    [
      'an interrupted turn after the message',
      [
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
        { type: 'turn.interrupted' },
      ],
    ],
    [
      'a trailing message after turn completion',
      [
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
        { type: 'turn.completed' },
        {
          type: 'item.completed',
          item: { type: 'agent_message', text: '{"trailing":true}' },
        },
      ],
    ],
    [
      'a new unfinished turn after prior completion',
      [
        { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
        { type: 'turn.completed' },
        { type: 'turn.started' },
      ],
    ],
  ])('rejects %s without a successful terminal turn', async (_name, events) => {
    const root = tempRoot();
    const stdout = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnSequence([{ stdout }]) as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    await expect(runner.run({
      prompt: 'trusted',
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    })).rejects.toThrow(/turn\.failed|successful terminal turn/i);
  });

  it('scrubs arbitrary child stderr from execution failures', async () => {
    const root = tempRoot();
    const sentinel = 'SENTINEL_CODEX_AUTH_MATERIAL_MUST_NOT_ESCAPE';
    const remove = vi.fn().mockResolvedValue(undefined);
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnSequence([{
        stdout: '',
        stderr: `provider failed with ${sentinel}`,
        code: 1,
      }]) as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove,
      ...fileSpies(),
    });

    let thrown: unknown;
    try {
      await runner.run({
        prompt: 'trusted',
        abort: new AbortController().signal,
        model: 'gpt-5.4-mini',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/semantic evaluator execution failed/i);
    expect((thrown as Error).message).not.toContain(sentinel);
    expect(remove).toHaveBeenCalledWith(root);
  });

  it('reaps the process group when output exceeds the bounded limit', async () => {
    const root = tempRoot();
    const child = new FakeChild(true);
    const killProcessGroup = vi.fn();
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: vi.fn(() => child as unknown as ChildProcess) as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      killProcessGroup,
      terminationGraceMs: 1,
      reapTimeoutMs: 1,
      ...fileSpies(),
    });
    const pending = runner.run({
      prompt: 'trusted',
      abort: new AbortController().signal,
      model: 'gpt-5.4-mini',
    });
    child.stdout.write(Buffer.alloc(17 * 1024 * 1024, 'x'));

    await expect(pending).rejects.toThrow(/output exceeded/i);
    expect(killProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGTERM');
  });

  it('reaps the process group on abort', async () => {
    const root = tempRoot();
    const child = new FakeChild(true);
    const killProcessGroup = vi.fn();
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const controller = new AbortController();
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      killProcessGroup,
      terminationGraceMs: 1,
      reapTimeoutMs: 1,
      ...fileSpies(),
    });
    const pending = runner.run({
      prompt: 'trusted',
      abort: controller.signal,
      model: 'gpt-5.4-mini',
    });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(killProcessGroup).toHaveBeenCalledWith(child.pid, 'SIGTERM');
  });

  it('preserves the isolated directory and marks cleanup unsafe when the child cannot be reaped', async () => {
    const root = tempRoot();
    const child = new FakeChild(false);
    const controller = new AbortController();
    const remove = vi.fn().mockResolvedValue(undefined);
    const spawnFn = vi.fn(() => child as unknown as ChildProcess);
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove,
      killProcessGroup: vi.fn(),
      terminationGraceMs: 1,
      reapTimeoutMs: 1,
      ...fileSpies(),
    });
    const pending = runner.run({
      prompt: 'trusted',
      abort: controller.signal,
      model: 'gpt-5.4-mini',
    });
    await vi.waitFor(() => expect(spawnFn).toHaveBeenCalledOnce());
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      cleanupUnsafe: true,
    });
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('CodexSemanticAgentRunner.isReady', () => {
  it('uses the provided environment as the auth authority for readiness and run', async () => {
    const authHome = tempRoot('jinn-codex-semantic-auth-');
    const readinessHome = tempRoot('jinn-codex-semantic-ready-home-');
    const runHome = tempRoot('jinn-codex-semantic-run-home-');
    const authFilePath = join(authHome, 'auth.json');
    writeFileSync(authFilePath, JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { refresh_token: 'fixture-refresh-token' },
    }), { mode: 0o600 });
    const environment = {
      PATH: '/usr/bin:/bin',
      CODEX_HOME: authHome,
    };
    const spawnFn = spawnSequence([
      ...readyProbeOutputs(),
      { stdout: finalAgentJsonl('{"outcome":"approve"}') },
    ]);
    const files = fileSpies();
    const makeTempDir = vi.fn()
      .mockResolvedValueOnce(readinessHome)
      .mockResolvedValueOnce(runHome);
    const previousKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'host-key-must-not-control-injected-environment';
    try {
      const runner = new CodexSemanticAgentRunner({
        environment,
        spawn: spawnFn as unknown as typeof spawn,
        makeTempDir,
        remove: vi.fn().mockResolvedValue(undefined),
        ...files,
      });

      await expect(runner.isReady()).resolves.toEqual({ ready: true });
      await expect(runner.run({
        prompt: 'trusted',
        abort: new AbortController().signal,
        model: 'gpt-5.4-mini',
      })).resolves.toBe('{"outcome":"approve"}');

      expect(files.copyFile).toHaveBeenCalledWith(
        authFilePath,
        join(runHome, 'auth.json'),
      );
      expect(spawnFn.mock.calls[4]![2]).toMatchObject({
        env: expect.objectContaining({
          PATH: '/usr/bin:/bin',
          HOME: runHome,
          CODEX_HOME: runHome,
        }),
      });
      expect(spawnFn.mock.calls[4]![2].env).not.toHaveProperty('OPENAI_API_KEY');
    } finally {
      if (previousKey === undefined) delete process.env['OPENAI_API_KEY'];
      else process.env['OPENAI_API_KEY'] = previousKey;
    }
  });

  it('probes OAuth, exact 0.136.x, help, features, and the no-provider isolation argv', async () => {
    const root = tempRoot('jinn-codex-semantic-ready-');
    const inspectOAuth = vi.fn(() => ({
      ready: true as const,
      authFilePath: '/canonical/auth.json',
    }));
    const spawnFn = spawnSequence(readyProbeOutputs());
    const runner = new CodexSemanticAgentRunner({
      codexPath: '/opt/codex',
      inspectOAuth,
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    await expect(runner.isReady()).resolves.toEqual({ ready: true });
    expect(inspectOAuth).toHaveBeenCalledOnce();
    expect(spawnFn.mock.calls.map((call) => call[1])).toEqual([
      ['--version'],
      ['exec', '--help'],
      ['features', 'list'],
      semanticArgs(root, '--help'),
    ]);
  });

  it('fails before any process when OAuth-only inspection is not ready', async () => {
    const makeTempDir = vi.fn();
    const spawnFn = vi.fn();
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: false,
        reason: 'ChatGPT OAuth is not configured',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir,
    });

    await expect(runner.isReady()).resolves.toEqual({
      ready: false,
      reason: 'Codex semantic evaluator requires ChatGPT OAuth',
    });
    expect(makeTempDir).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it.each(['0.135.9', '0.137.0', '1.0.0'])(
    'rejects Codex CLI %s outside the deliberately verified 0.136.x contract',
    async (version) => {
      const root = tempRoot();
      const spawnFn = spawnSequence([{ stdout: `codex-cli ${version}\n` }]);
      const runner = new CodexSemanticAgentRunner({
        inspectOAuth: vi.fn(() => ({
          ready: true,
          authFilePath: '/canonical/auth.json',
        })),
        spawn: spawnFn as unknown as typeof spawn,
        makeTempDir: async () => root,
        remove: vi.fn().mockResolvedValue(undefined),
        ...fileSpies(),
      });

      await expect(runner.isReady()).resolves.toEqual({
        ready: false,
        reason: expect.stringContaining('requires Codex CLI 0.136.x'),
      });
      expect(spawnFn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['prefixed line', 'warning\ncodex-cli 0.136.0\n'],
    ['suffixed line', 'codex-cli 0.136.0\nwarning\n'],
    ['multiple version lines', 'codex-cli 0.136.0\ncodex-cli 0.137.0\n'],
    ['same-line suffix', 'codex-cli 0.136.0 unexpected\n'],
    ['same-line prefix', 'warning codex-cli 0.136.0\n'],
  ])('rejects non-canonical --version output with a %s', async (_name, stdout) => {
    const root = tempRoot();
    const spawnFn = spawnSequence([{ stdout }]);
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    await expect(runner.isReady()).resolves.toEqual({
      ready: false,
      reason: expect.stringContaining('canonical'),
    });
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('fails closed when exec help omits any required isolation option', async () => {
    const root = tempRoot();
    const helpWithoutStrictConfig = REQUIRED_HELP_OPTIONS
      .filter((option) => option !== '--strict-config')
      .join('\n');
    const spawnFn = spawnSequence(readyProbeOutputs({
      help: { stdout: helpWithoutStrictConfig },
    }));
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    await expect(runner.isReady()).resolves.toEqual({
      ready: false,
      reason: expect.stringContaining('--strict-config'),
    });
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it('fails closed when features list omits any explicitly disabled feature', async () => {
    const root = tempRoot();
    const withoutFastMode = DISABLED_FEATURES
      .filter((feature) => feature !== 'fast_mode')
      .join('\n');
    const spawnFn = spawnSequence(readyProbeOutputs({
      features: { stdout: withoutFastMode },
    }));
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    await expect(runner.isReady()).resolves.toEqual({
      ready: false,
      reason: expect.stringContaining('fast_mode'),
    });
    expect(spawnFn).toHaveBeenCalledTimes(3);
  });

  it('fails closed when the exact no-provider validation probe exits non-zero', async () => {
    const root = tempRoot();
    const sentinel = 'SENTINEL_READINESS_AUTH_MATERIAL_MUST_NOT_ESCAPE';
    const spawnFn = spawnSequence(readyProbeOutputs({
      validation: {
        stdout: '',
        stderr: `unknown feature: ${sentinel}`,
        code: 2,
      },
    }));
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir: async () => root,
      remove: vi.fn().mockResolvedValue(undefined),
      ...fileSpies(),
    });

    const result = await runner.isReady();
    expect(result.ready).toBe(false);
    expect(result.reason).toMatch(/unavailable/i);
    expect(result.reason).not.toContain(sentinel);
    expect(result.reason!.length).toBeLessThanOrEqual(1_000);
    expect(spawnFn).toHaveBeenCalledTimes(4);
  });

  it('shares one in-flight readiness probe across duplicate concurrent callers', async () => {
    const root = tempRoot();
    const spawnFn = spawnSequence(readyProbeOutputs());
    const makeTempDir = vi.fn().mockResolvedValue(root);
    const runner = new CodexSemanticAgentRunner({
      inspectOAuth: vi.fn(() => ({
        ready: true,
        authFilePath: '/canonical/auth.json',
      })),
      spawn: spawnFn as unknown as typeof spawn,
      makeTempDir,
      remove: vi.fn().mockResolvedValue(undefined),
      readinessCacheMs: 30_000,
      ...fileSpies(),
    });

    const [first, second] = await Promise.all([
      runner.isReady(),
      runner.isReady(),
    ]);
    expect(first).toEqual({ ready: true });
    expect(second).toEqual({ ready: true });
    expect(makeTempDir).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledTimes(4);
  });
});
