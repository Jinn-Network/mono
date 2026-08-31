// operator/test/harnesses/impls/hermes-agent/adapter.test.ts
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as yamlParse } from 'yaml';
import { HermesHarnessAdapter } from '../../../../src/harnesses/impls/hermes-agent/adapter.js';
import { ResolvedHermesModelMismatchError } from '../../../../src/harnesses/impls/hermes-agent/resolved-model-guard.js';
import type { TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

type SpawnCall = {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
};

function fakeHermesChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  setImmediate(() => {
    child.emit('exit', 0, null);
  });
  return child;
}

function inputs(workingDir: string, implStateDir: string): TaskSessionInputs {
  return {
    taskId: 'task-1',
    requestId: 'req-1',
    taskCid: 'bafy…',
    solverType: 'swe-rebench-v2.v1',
    model: 'anthropic/claude-opus-4.6',
    implStateDir,
    workingDir,
    pluginRoots: [networkToolsRoot],
    windowStartTs: 0,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    mode: 'train',
    taskBody: {
      id: 'task-1',
      description: 'test',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'Unidata/netcdf-c', base_commit: 'a'.repeat(40) },
    },
  };
}

describe('HermesHarnessAdapter', () => {
  // These tests assert on the model/provider the adapter resolves, and
  // `buildHermesConfig` gives `JINN_HERMES_MODEL` / `JINN_HERMES_PROVIDER`
  // precedence over the per-task inputs (bootstrap.ts). Both are documented
  // operator overrides, so a contributor may legitimately have them exported;
  // isolate them per test so the suite never reads ambient state.
  const AMBIENT_ENV_KEYS = ['JINN_HERMES_MODEL', 'JINN_HERMES_PROVIDER'] as const;
  const ambientSaved: Partial<Record<(typeof AMBIENT_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of AMBIENT_ENV_KEYS) {
      ambientSaved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of AMBIENT_ENV_KEYS) {
      if (ambientSaved[key] === undefined) delete process.env[key];
      else process.env[key] = ambientSaved[key];
    }
  });

  it('spawns hermes chat -q with model/provider flags and HERMES_HOME env', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesProvider: 'anthropic',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.command).toBe('/bin/fake-hermes');
      expect(call.args).toContain('chat');
      expect(call.args).toContain('-q');
      // Quiet/programmatic mode — suppress banner/spinner/tool previews.
      expect(call.args).toContain('-Q');
      expect(call.args).toContain('--model');
      expect(call.args).toContain('anthropic/claude-opus-4.6');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('anthropic');
      // No `-w <workingDir>` — `hermes chat` has no such flag (`--worktree` is
      // a boolean we deliberately don't pass); the cwd comes from the spawn
      // options + `terminal.cwd` in the per-Task config.yaml.
      expect(call.args).not.toContain('-w');
      expect(call.options.cwd).toBe(work);
      expect(call.options.env?.HERMES_HOME).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('infers --provider openrouter when hermesProvider is unset and model has <org>/<model> format', async () => {
    // gh #293: HERMES_MODELS catalog ships OpenRouter-format ids. Without
    // this inference, Hermes falls back to its operator-pinned provider
    // default (usually google-gemini-cli) and routes a deepseek/... id to
    // Google → HTTP 404 Code Assist. This is a v0.1.6 patch; the proper
    // fix (provider as first-class catalog field) is gh #295.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        // hermesProvider deliberately unset — exercise the inference path.
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      // inputs() defaults model to 'anthropic/claude-opus-4.6' — slashed format.
      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('openrouter');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('uses Hermes custom provider and writes base_url when a local provider URL is configured', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesModel: 'qwen2.5-coder:7b',
        hermesProvider: 'openrouter',
        hermesBaseUrl: 'http://127.0.0.1:11434/v1',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--model');
      expect(call.args).toContain('qwen2.5-coder:7b');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('custom');

      const cfg = yamlParse(readFileSync(join(home, 'config.yaml'), 'utf8')) as any;
      expect(cfg.model.default).toBe('qwen2.5-coder:7b');
      expect(cfg.model.provider).toBe('custom');
      expect(cfg.model.base_url).toBe('http://127.0.0.1:11434/v1');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('prefers configured local model over SolverNet catalog model when local provider URL is configured', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesModel: 'qwen2.5-coder:7b',
        hermesBaseUrl: 'http://127.0.0.1:11434/v1',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.model = 'anthropic/claude-opus-4.7';
      await adapter.runTask(taskInputs);

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--model');
      expect(call.args).toContain('qwen2.5-coder:7b');
      expect(call.args).not.toContain('anthropic/claude-opus-4.7');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('custom');

      const cfg = yamlParse(readFileSync(join(home, 'config.yaml'), 'utf8')) as any;
      expect(cfg.model.default).toBe('qwen2.5-coder:7b');
      expect(cfg.model.provider).toBe('custom');
      expect(cfg.model.base_url).toBe('http://127.0.0.1:11434/v1');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not pass SolverNet catalog model to local provider without a local model override', async () => {
    const spawnCalls: SpawnCall[] = [];
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-home-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      writeFileSync(
        join(operatorHome, 'config.yaml'),
        'model:\n  default: anthropic/claude-opus-4.7\n  provider: openrouter\n',
        'utf8',
      );

      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: operatorHome,
        hermesBaseUrl: 'http://127.0.0.1:11434/v1',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, taskHome);
      taskInputs.model = 'anthropic/claude-opus-4.7';
      await adapter.runTask(taskInputs);

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).not.toContain('--model');
      expect(call.args).not.toContain('anthropic/claude-opus-4.7');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('custom');

      const cfg = yamlParse(readFileSync(join(taskHome, 'config.yaml'), 'utf8')) as any;
      expect(cfg.model.default).toBeUndefined();
      expect(cfg.model.provider).toBe('custom');
      expect(cfg.model.base_url).toBe('http://127.0.0.1:11434/v1');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('keeps SolverNet catalog model precedence when no local provider URL is configured', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesModel: 'qwen2.5-coder:7b',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.model = 'anthropic/claude-opus-4.7';
      await adapter.runTask(taskInputs);

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--model');
      expect(call.args).toContain('anthropic/claude-opus-4.7');
      expect(call.args).not.toContain('qwen2.5-coder:7b');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('openrouter');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('omits --provider when hermesProvider is unset and model has no slash', async () => {
    // Inference must NOT fire on bare model ids (e.g. `gpt-4o`,
    // `claude-haiku-4-5-20251001`). Those should fall through to whatever
    // the operator's `$HERMES_HOME/config.yaml` resolves.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.model = 'gpt-4o';
      await adapter.runTask(taskInputs);

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--model');
      expect(call.args).toContain('gpt-4o');
      expect(call.args).not.toContain('--provider');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('explicit hermesProvider wins over inference', async () => {
    // Regression guard: if the operator deliberately pins a provider (env
    // var, future per-join field), inference must NOT override it. Catches
    // a footgun where the inference grows beyond OpenRouter detection and
    // silently re-routes operators away from their pinned setup.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesProvider: 'nous-portal',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      // Slashed model id — inference WOULD return 'openrouter' if not for
      // the explicit hermesProvider above.
      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('nous-portal');
      expect(call.args).not.toContain('openrouter');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('per-task inputs.provider (string) routes a non-OpenRouter catalog entry through its declared provider', async () => {
    // Acceptance #1 (issue #1243): a Hermes catalog entry whose provider is not
    // OpenRouter must route through its declared provider. The per-task provider
    // is threaded first-class from the joined SolverNet entry.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        // No daemon-global hermesProvider — the per-task route must win.
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.model = 'some-vendor/some-model';
      taskInputs.provider = 'nous-portal';
      await adapter.runTask(taskInputs);

      const call = spawnCalls[0];
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('nous-portal');
      // Inference would have said openrouter for the slashed id — the
      // first-class per-task provider overrides it.
      expect(call.args).not.toContain('openrouter');

      const cfg = yamlParse(readFileSync(join(home, 'config.yaml'), 'utf8')) as any;
      expect(cfg.model.provider).toBe('nous-portal');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('per-task provider object writes base_url + provider and injects authVar env', async () => {
    // Acceptance #3 (issue #1243): a custom provider object produces the
    // expected Hermes config (base_url + provider) and injects its credential
    // env var even when the var name is outside the pattern allowlist.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    const AUTH_VAR = 'MY_CUSTOM_ENDPOINT_CRED';
    const originalAuth = process.env[AUTH_VAR];
    process.env[AUTH_VAR] = 'secret-cred-value';

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.model = 'my-model';
      taskInputs.provider = {
        name: 'my-endpoint',
        baseUrl: 'http://127.0.0.1:9000/v1',
        authVar: AUTH_VAR,
      };
      await adapter.runTask(taskInputs);

      const call = spawnCalls[0];
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('my-endpoint');

      const cfg = yamlParse(readFileSync(join(home, 'config.yaml'), 'utf8')) as any;
      expect(cfg.model.provider).toBe('my-endpoint');
      expect(cfg.model.base_url).toBe('http://127.0.0.1:9000/v1');

      // The bespoke credential var does NOT match the *_API_KEY/*_TOKEN
      // pattern; it must still reach the child because the provider named it.
      expect(call.options.env?.[AUTH_VAR]).toBe('secret-cred-value');
    } finally {
      if (originalAuth === undefined) delete process.env[AUTH_VAR];
      else process.env[AUTH_VAR] = originalAuth;
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('warns when a provider authVar names an unset env var and does not fire when it is present', async () => {
    // Observability gap (issue #1243): a custom provider object declaring
    // `authVar: 'MY_CRED'` with `process.env.MY_CRED` unset silently skips the
    // credential injection, and Hermes dies later at first model call with a
    // generic "empty API key" and no diagnostic. Warn (do NOT throw) naming the
    // missing env var so the misconfiguration is diagnosable.
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    const AUTH_VAR = 'MISSING_CUSTOM_ENDPOINT_CRED';
    const originalAuth = process.env[AUTH_VAR];
    delete process.env[AUTH_VAR];

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn(() => fakeHermesChild() as any) as any,
      });

      // Unset authVar → warn fires, run still proceeds (injection skipped).
      const missingInputs = inputs(work, home);
      missingInputs.model = 'my-model';
      missingInputs.provider = {
        name: 'my-endpoint',
        baseUrl: 'http://127.0.0.1:9000/v1',
        authVar: AUTH_VAR,
      };
      await adapter.runTask(missingInputs);

      const missingWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes(AUTH_VAR));
      expect(missingWarn).toBeDefined();

      // Now with the var present → no warn about a missing authVar.
      warnSpy.mockClear();
      process.env[AUTH_VAR] = 'secret-cred-value';
      const presentInputs = inputs(work, home);
      presentInputs.model = 'my-model';
      presentInputs.provider = {
        name: 'my-endpoint',
        baseUrl: 'http://127.0.0.1:9000/v1',
        authVar: AUTH_VAR,
      };
      await adapter.runTask(presentInputs);

      const presentWarn = warnSpy.mock.calls.find((c) => String(c[0]).includes(AUTH_VAR));
      expect(presentWarn).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
      if (originalAuth === undefined) delete process.env[AUTH_VAR];
      else process.env[AUTH_VAR] = originalAuth;
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('per-task inputs.provider wins over daemon-global hermesProvider and inference', async () => {
    // Precedence guard (issue #1243): inputs.provider > hermesProvider > inference.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        hermesProvider: 'daemon-global-provider',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.provider = 'per-task-provider';
      await adapter.runTask(taskInputs);

      const call = spawnCalls[0];
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('per-task-provider');
      expect(call.args).not.toContain('daemon-global-provider');
      expect(call.args).not.toContain('openrouter');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('forwards abort signal to SIGTERM on the child', async () => {
    const controller = new AbortController();
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));
    let child: ReturnType<typeof fakeHermesChild> | null = null;

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((_c: string, _a: string[], _o: any) => {
          // Build a child that does NOT auto-exit so the test can abort mid-run
          const c = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            killed: boolean;
            kill: ReturnType<typeof vi.fn>;
          };
          c.stdout = new EventEmitter();
          c.stderr = new EventEmitter();
          c.killed = false;
          c.kill = vi.fn(() => { c.killed = true; return true; });
          child = c;
          return child as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.abort = controller.signal;

      const runPromise = adapter.runTask(taskInputs);
      // Allow spawn to register listeners
      await new Promise((r) => setImmediate(r));

      controller.abort();
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM');

      // Resolve the run by emitting exit
      child!.emit('exit', null, 'SIGTERM');
      await runPromise;
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('passes provider credentials from parent env to hermes chat', async () => {
    // Regression for: `hermes chat` was spawned with a stripped env that did
    // not include `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` / etc., so the
    // child loaded the per-Task `.env` (which only contains Jinn-runtime
    // keys when the operator's `$HERMES_HOME/.env` doesn't exist — common
    // for substrate-isolated operators) and hit "Provider resolver returned
    // an empty API key" → exit 1 ~14s after launch (after plugin discovery
    // + MCP registration but before the first model call).
    //
    // Fix: pattern-allow `*_API_KEY`, `*_API_TOKEN`, `*_TOKEN`, `HERMES_*`
    // from `process.env` into the child env.
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    // Seed parent env with a mix of provider creds (must pass through) and
    // unrelated vars (must NOT pass through — keeps the spawn env tight).
    const SENTINELS = {
      OPENROUTER_API_KEY: 'sk-or-v1-test-passthrough',
      ANTHROPIC_API_KEY: 'sk-ant-test-passthrough',
      GOOGLE_API_KEY: 'goog-test',
      XAI_API_KEY: 'xai-test',
      GROQ_API_KEY: 'groq-test',
      HUGGINGFACE_API_TOKEN: 'hf-test',
      GITHUB_TOKEN: 'gh-test',                  // matches *_TOKEN
      HERMES_ACCEPT_HOOKS: '1',                 // matches HERMES_*
      JINN_INTERNAL_SECRET: 'should-not-pass',  // unrelated — must be stripped
    };
    const originalEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(SENTINELS)) {
      originalEnv[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const childEnv = spawnCalls[0].options.env ?? {};
      // Provider creds passed through — without these `hermes chat` exits 1.
      expect(childEnv.OPENROUTER_API_KEY).toBe(SENTINELS.OPENROUTER_API_KEY);
      expect(childEnv.ANTHROPIC_API_KEY).toBe(SENTINELS.ANTHROPIC_API_KEY);
      expect(childEnv.GOOGLE_API_KEY).toBe(SENTINELS.GOOGLE_API_KEY);
      expect(childEnv.XAI_API_KEY).toBe(SENTINELS.XAI_API_KEY);
      expect(childEnv.GROQ_API_KEY).toBe(SENTINELS.GROQ_API_KEY);
      expect(childEnv.HUGGINGFACE_API_TOKEN).toBe(SENTINELS.HUGGINGFACE_API_TOKEN);
      expect(childEnv.GITHUB_TOKEN).toBe(SENTINELS.GITHUB_TOKEN);
      // Hermes-specific knob passed through (HERMES_HOME is set by extra and
      // wins anyway; verify a non-overlapping HERMES_* key).
      expect(childEnv.HERMES_ACCEPT_HOOKS).toBe('1');
      // Unrelated env stays out — keeps the spawn env tight.
      expect(childEnv.JINN_INTERNAL_SECRET).toBeUndefined();
    } finally {
      // Restore original env so this test doesn't pollute neighbours.
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('lifts only THIS run\'s session record, never a prior task\'s stale one (AC-1)', async () => {
    // AC-1: the raw Hermes session record must land under workingDir so it rides
    // system_snapshot (which tars only workingDir). $HERMES_HOME is shared across
    // tasks of a solverType, so a stale prior record must NEVER be lifted — only
    // a record written after this run's pre-spawn baseline.
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const sessionsDir = join(home, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      // A prior task's record, already present before this run — must NOT be lifted.
      const stale = { session_id: 'stale', messages: [{ role: 'user', content: 'a prior task' }] };
      writeFileSync(join(sessionsDir, 'session_stale.json'), JSON.stringify(stale));
      utimesSync(join(sessionsDir, 'session_stale.json'), new Date(2_000_000), new Date(2_000_000));

      const fresh = {
        session_id: 'fresh',
        messages: [
          { role: 'user', content: 'Fix the failing test' },
          { role: 'assistant', content: 'done' },
        ],
      };

      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        // The child writes this run's record AFTER the pre-spawn baseline snapshot,
        // so its (real-now) mtime is strictly newer than the stale prior record.
        _spawnFn: vi.fn(() => {
          writeFileSync(join(sessionsDir, 'session_fresh.json'), JSON.stringify(fresh));
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      const lifted = JSON.parse(
        readFileSync(join(work, '.hermes-agent', 'session.json'), 'utf8'),
      );
      // This run's record wins; the stale prior record is never lifted.
      expect(lifted.session_id).toBe('fresh');
      expect(lifted.messages).toEqual(fresh.messages);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('degrades (lifts nothing) when the solve writes no record even though a stale prior record exists', async () => {
    // The no-record edge #1670's review flagged: a prior task's record is present
    // but this run wrote none. The lift must copy nothing rather than bleed the
    // foreign record into this task's signed snapshot/trajectory.
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const sessionsDir = join(home, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const stale = { session_id: 'stale', messages: [{ role: 'user', content: 'a prior task' }] };
      writeFileSync(join(sessionsDir, 'session_stale.json'), JSON.stringify(stale));
      utimesSync(join(sessionsDir, 'session_stale.json'), new Date(2_000_000), new Date(2_000_000));

      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn(() => fakeHermesChild() as any) as any, // writes no record
      });

      await adapter.runTask(inputs(work, home));

      expect(existsSync(join(work, '.hermes-agent', 'session.json'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('does not fail the solve when the sessions dir is missing/empty (AC-3 degradation)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      // No sessions/ dir under home — the lift must degrade, not throw.
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn(() => fakeHermesChild() as any) as any,
      });

      await expect(adapter.runTask(inputs(work, home))).resolves.toBeUndefined();
      // No transcript lifted — degradation, not failure.
      expect(existsSync(join(work, '.hermes-agent', 'session.json'))).toBe(false);
    } finally {
      warnSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe('HermesHarnessAdapter T3.1 resolved-model guard', () => {
  const T31_ENV_KEYS = [
    'JINN_T31_EXPECTED_HERMES_MODEL',
    'JINN_T31_EXPECTED_HERMES_PROVIDER',
    'JINN_T31_APPROVED_HERMES_MODEL',
    'JINN_T31_APPROVED_HERMES_PROVIDER',
    'JINN_HERMES_MODEL',
    'JINN_HERMES_PROVIDER',
  ] as const;
  const saved: Partial<Record<(typeof T31_ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of T31_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of T31_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('does not spawn Hermes when an unapproved env override writes a different model', async () => {
    process.env['JINN_T31_EXPECTED_HERMES_MODEL'] = 'deepseek/deepseek-v4-flash';
    process.env['JINN_T31_EXPECTED_HERMES_PROVIDER'] = 'openrouter';
    process.env['JINN_HERMES_MODEL'] = 'anthropic/claude-opus-4.6';
    process.env['JINN_HERMES_PROVIDER'] = 'anthropic';

    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const task = inputs(work, home);
      task.model = 'deepseek/deepseek-v4-flash';
      await expect(adapter.runTask(task)).rejects.toBeInstanceOf(ResolvedHermesModelMismatchError);
      expect(spawnCalls).toHaveLength(0);
      expect(existsSync(join(home, 'config.yaml'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('spawns when the written config matches an approved explicit override', async () => {
    process.env['JINN_T31_EXPECTED_HERMES_MODEL'] = 'deepseek/deepseek-v4-flash';
    process.env['JINN_T31_EXPECTED_HERMES_PROVIDER'] = 'openrouter';
    process.env['JINN_T31_APPROVED_HERMES_MODEL'] = 'google/gemini-2.5-flash';
    process.env['JINN_T31_APPROVED_HERMES_PROVIDER'] = 'openrouter';
    process.env['JINN_HERMES_MODEL'] = 'google/gemini-2.5-flash';
    process.env['JINN_HERMES_PROVIDER'] = 'openrouter';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        operatorHermesHome: home,
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      const task = inputs(work, home);
      task.model = 'google/gemini-2.5-flash';
      task.provider = 'openrouter';
      await adapter.runTask(task);
      expect(spawnCalls).toHaveLength(1);
      expect(logSpy.mock.calls.some(([line]) =>
        String(line).includes('T3.1 resolved-model guard ok') &&
        String(line).includes('approved override of requested model=deepseek/deepseek-v4-flash'),
      )).toBe(true);
    } finally {
      logSpy.mockRestore();
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
