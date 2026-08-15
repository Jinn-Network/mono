// operator/test/harnesses/impls/hermes-agent/bootstrap.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as yamlParse } from 'yaml';
import {
  writePerTaskHermesConfig,
  JINN_HERMES_MAX_TOKENS_CAP,
} from '../../../../src/harnesses/impls/hermes-agent/bootstrap.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));
const sweRuntimeRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));

function readConfig(home: string): Record<string, any> {
  return yamlParse(readFileSync(join(home, 'config.yaml'), 'utf8'));
}

describe('writePerTaskHermesConfig', () => {
  it('writes config.yaml with mcp_servers, skills, terminal, and toolset allowlist (no operator config)', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        model: 'anthropic/claude-opus-4.6',
        provider: 'anthropic',
        solverPluginRoots: [networkToolsRoot, sweRuntimeRoot],
        env: {
          storePath: '/tmp/jinn.db',
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok',
          corpusEnv: {},
        },
      });

      const cfg = readConfig(home);
      // Model block — Jinn override applied.
      expect(cfg.model.default).toBe('anthropic/claude-opus-4.6');
      expect(cfg.model.provider).toBe('anthropic');
      // Terminal block — Jinn enforces local backend + per-Task cwd.
      expect(cfg.terminal.backend).toBe('local');
      expect(cfg.terminal.cwd).toBe('/work');
      // Toolset allowlist — exactly the 8-item Jinn list.
      expect(cfg.platform_toolsets['hermes-cli']).toEqual([
        'terminal', 'file', 'web', 'skills',
        'memory', 'session_search', 'todo', 'code_execution',
      ]);
      // Footgun toolsets must NOT appear.
      const allowlist = cfg.platform_toolsets['hermes-cli'] as string[];
      for (const banned of ['messaging', 'cronjob', 'browser', 'computer_use', 'vision', 'tts']) {
        expect(allowlist).not.toContain(banned);
      }
      // MCP servers (translated from network-tools/.mcp.json).
      expect(cfg.mcp_servers['jinn-client']).toBeDefined();
      expect(cfg.mcp_servers['jinn-client'].command).toBe('node');
      // Skills external_dirs from swe-rebench-v2-runtime.
      expect(cfg.skills.external_dirs).toEqual([
        expect.stringMatching(/swe-rebench-v2-runtime\/skills$/),
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes a local OpenAI-compatible base_url when supplied by Jinn', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        model: 'qwen2.5-coder:7b',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:11434/v1',
        solverPluginRoots: [],
        env: {
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok',
          corpusEnv: {},
        },
      });

      const cfg = readConfig(home);
      expect(cfg.model.default).toBe('qwen2.5-coder:7b');
      expect(cfg.model.provider).toBe('custom');
      expect(cfg.model.base_url).toBe('http://127.0.0.1:11434/v1');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes .env with daemon credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        solverPluginRoots: [],
        env: {
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok-xyz',
          corpusEnv: { discoveryUrl: 'https://discovery.example/' },
        },
      });
      const envFile = readFileSync(join(home, '.env'), 'utf8');
      expect(envFile).toContain('DAEMON_API_TOKEN=tok-xyz');
      expect(envFile).toContain('DAEMON_API_URL=http://127.0.0.1:7331');
      expect(envFile).toContain('JINN_DISCOVERY_URL=https://discovery.example/');
      expect(envFile).toContain('JINN_DISCOVERY_MODE=http');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('seeds auth/ and auth.json from the operator home into a fresh per-Task home', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      mkdirSync(join(operatorHome, 'auth'), { recursive: true });
      writeFileSync(join(operatorHome, 'auth', 'google_oauth.json'), '{"refresh":"r","access":"a","expires":0,"email":"x"}');
      writeFileSync(join(operatorHome, 'auth.json'), '{"providers":{}}');

      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: operatorHome,
      });

      expect(existsSync(join(taskHome, 'auth', 'google_oauth.json'))).toBe(true);
      expect(readFileSync(join(taskHome, 'auth', 'google_oauth.json'), 'utf8')).toContain('"refresh":"r"');
      expect(existsSync(join(taskHome, 'auth.json'))).toBe(true);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('does not overwrite auth/ that already exists in the per-Task home', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      mkdirSync(join(operatorHome, 'auth'), { recursive: true });
      writeFileSync(join(operatorHome, 'auth', 'google_oauth.json'), '{"refresh":"OPERATOR"}');
      mkdirSync(join(taskHome, 'auth'), { recursive: true });
      writeFileSync(join(taskHome, 'auth', 'google_oauth.json'), '{"refresh":"EXISTING"}');

      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: operatorHome,
      });

      expect(readFileSync(join(taskHome, 'auth', 'google_oauth.json'), 'utf8')).toContain('EXISTING');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('merges the operator .env into the per-Task .env (Jinn keys last, override any duplicates)', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      writeFileSync(
        join(operatorHome, '.env'),
        [
          'OPENROUTER_API_KEY=sk-or-OP_KEY_REDACTED',
          'ANTHROPIC_API_KEY=sk-ant-OP_KEY_REDACTED',
          'OPERATOR_CUSTOM_FLAG=on',
          'DAEMON_API_URL=http://operator-set:9999',
        ].join('\n') + '\n',
      );

      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok-jinn', corpusEnv: {} },
        seedFrom: operatorHome,
      });

      const envFile = readFileSync(join(taskHome, '.env'), 'utf8');
      expect(envFile).toContain('OPENROUTER_API_KEY=sk-or-OP_KEY_REDACTED');
      expect(envFile).toContain('ANTHROPIC_API_KEY=sk-ant-OP_KEY_REDACTED');
      expect(envFile).toContain('OPERATOR_CUSTOM_FLAG=on');
      const operatorIdx = envFile.indexOf('DAEMON_API_URL=http://operator-set:9999');
      const jinnIdx = envFile.indexOf('DAEMON_API_URL=http://127.0.0.1:7331');
      expect(operatorIdx).toBeGreaterThanOrEqual(0);
      expect(jinnIdx).toBeGreaterThan(operatorIdx);
      expect(envFile).toContain('DAEMON_API_TOKEN=tok-jinn');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('merges the operator config.yaml — anything not Jinn-managed passes through; Jinn-managed keys are authoritative', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      // A reasonably rich operator config.yaml — covers every category of
      // setting that we want to inherit verbatim plus a couple Jinn must
      // override.
      writeFileSync(
        join(operatorHome, 'config.yaml'),
        [
          'model:',
          '  default: "operator-default"',
          '  provider: "operator-provider"',
          '  max_tokens: 16000',
          '  context_length: 131072',
          '  base_url: "https://op.example/v1"',
          '',
          'provider_routing:',
          '  sort: "price"',
          '',
          'openrouter:',
          '  response_cache: true',
          '  response_cache_ttl: 300',
          '',
          'agent:',
          '  iteration_budget: 50',
          '',
          'compression:',
          '  threshold: 0.9',
          '',
          'auxiliary:',
          '  vision:',
          '    backend: gemini',
          '',
          'providers:',
          '  ollama-local:',
          '    request_timeout_seconds: 300',
          '',
          'terminal:',
          '  backend: docker',           // Jinn must override → local
          '  timeout: 600',              // passes through
          '  lifetime_seconds: 900',     // passes through
          '  docker_image: "custom"',    // passes through (inert under local)',
          '',
          'platform_toolsets:',
          '  hermes-cli:',                // Jinn replaces this list
          '    - browser',                // (operator tried to enable a footgun)
          '    - cronjob',
          '  hermes-telegram:',           // other-platform allowlist passes through
          '    - terminal',
          '',
          'mcp_servers:',
          '  github:',                    // operator's MCP — passes through',
          '    command: "/op/github-mcp"',
          '',
          'skills:',
          '  external_dirs:',
          '    - "/home/op/skills"',       // operator's dir — preserved
          '',
        ].join('\n'),
      );

      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/wd',
        model: 'jinn-overridden-model',      // Jinn provides daemon/SolverNet model
        provider: 'jinn-overridden-provider',
        solverPluginRoots: [networkToolsRoot, sweRuntimeRoot],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: operatorHome,
      });

      const cfg = readConfig(taskHome);

      // ── model — operator's fields preserved; Jinn's default+provider win ──
      expect(cfg.model.default).toBe('jinn-overridden-model');
      expect(cfg.model.provider).toBe('jinn-overridden-provider');
      expect(cfg.model.max_tokens).toBe(16000);
      expect(cfg.model.context_length).toBe(131072);
      expect(cfg.model.base_url).toBe('https://op.example/v1');

      // ── operator-only top-level blocks all pass through unchanged ──
      expect(cfg.provider_routing).toEqual({ sort: 'price' });
      expect(cfg.openrouter).toEqual({ response_cache: true, response_cache_ttl: 300 });
      expect(cfg.agent).toEqual({ iteration_budget: 50 });
      expect(cfg.compression).toEqual({ threshold: 0.9 });
      expect(cfg.auxiliary.vision.backend).toBe('gemini');
      expect(cfg.providers['ollama-local'].request_timeout_seconds).toBe(300);

      // ── terminal — Jinn forces backend+cwd; operator's other terminal fields kept ──
      expect(cfg.terminal.backend).toBe('local');
      expect(cfg.terminal.cwd).toBe('/wd');
      expect(cfg.terminal.timeout).toBe(600);
      expect(cfg.terminal.lifetime_seconds).toBe(900);
      expect(cfg.terminal.docker_image).toBe('custom');

      // ── platform_toolsets — Jinn replaces hermes-cli with the allowlist;
      //    other platforms (hermes-telegram) pass through ──
      expect(cfg.platform_toolsets['hermes-cli']).toEqual([
        'terminal', 'file', 'web', 'skills',
        'memory', 'session_search', 'todo', 'code_execution',
      ]);
      // Operator's footgun additions GONE.
      expect(cfg.platform_toolsets['hermes-cli']).not.toContain('browser');
      expect(cfg.platform_toolsets['hermes-cli']).not.toContain('cronjob');
      expect(cfg.platform_toolsets['hermes-telegram']).toEqual(['terminal']);

      // ── mcp_servers — operator's `github` preserved; Jinn's `jinn-client` added ──
      expect(cfg.mcp_servers.github.command).toBe('/op/github-mcp');
      expect(cfg.mcp_servers['jinn-client']).toBeDefined();

      // ── skills.external_dirs — operator first, Jinn's appended ──
      expect(cfg.skills.external_dirs[0]).toBe('/home/op/skills');
      expect(cfg.skills.external_dirs.some((d: string) => d.endsWith('swe-rebench-v2-runtime/skills'))).toBe(true);
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('passes through operator config.yaml even when no Jinn model/provider override is given', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      writeFileSync(
        join(operatorHome, 'config.yaml'),
        'model:\n  default: "op-only-model"\n  max_tokens: 8192\n',
      );

      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/wd',
        // no model, no provider — bare daemon (operator's choices apply)
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: operatorHome,
      });

      const cfg = readConfig(taskHome);
      expect(cfg.model.default).toBe('op-only-model');
      expect(cfg.model.max_tokens).toBe(8192);
      // Jinn-managed keys still authoritative.
      expect(cfg.terminal.backend).toBe('local');
      expect(cfg.terminal.cwd).toBe('/wd');
      expect(cfg.platform_toolsets['hermes-cli']).toContain('terminal');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  // The OpenRouter pre-billing footgun: max_tokens is reserved against the
  // operator's credit balance at request time, so a stock Hermes default
  // (64000) drains the wallet on every claim even when the actual solve
  // only emits a few thousand tokens. Jinn caps max_tokens at
  // JINN_HERMES_MAX_TOKENS_CAP (32000) per the constant docstring and the
  // 2026-05-23 production bug. These tests pin the cap so a future bump
  // doesn't silently regress.
  describe('max_tokens cap', () => {
    it('pins the cap at 32000', () => {
      expect(JINN_HERMES_MAX_TOKENS_CAP).toBe(32000);
    });

    it('writes max_tokens=cap when no operator config is seeded', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        });
        const cfg = readConfig(home);
        expect(cfg.model.max_tokens).toBe(JINN_HERMES_MAX_TOKENS_CAP);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('writes max_tokens=cap when a Jinn model is supplied but operator has no config', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          model: 'anthropic/claude-opus-4.6',
          provider: 'openrouter',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        });
        const cfg = readConfig(home);
        expect(cfg.model.default).toBe('anthropic/claude-opus-4.6');
        expect(cfg.model.max_tokens).toBe(JINN_HERMES_MAX_TOKENS_CAP);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('clamps an over-cap operator max_tokens to the cap', () => {
      const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
      const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
      try {
        // Operator pinned 64000 — exactly the value that drove the 2026-05-23
        // 402 burn. Jinn must clamp this to the cap regardless.
        writeFileSync(
          join(operatorHome, 'config.yaml'),
          'model:\n  default: "op-model"\n  max_tokens: 64000\n',
        );
        writePerTaskHermesConfig({
          hermesHome: taskHome,
          workingDir: '/work',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          seedFrom: operatorHome,
        });
        const cfg = readConfig(taskHome);
        expect(cfg.model.max_tokens).toBe(JINN_HERMES_MAX_TOKENS_CAP);
      } finally {
        rmSync(operatorHome, { recursive: true, force: true });
        rmSync(taskHome, { recursive: true, force: true });
      }
    });

    it('preserves an under-cap operator max_tokens (operators may pin lower)', () => {
      const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
      const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
      try {
        writeFileSync(
          join(operatorHome, 'config.yaml'),
          'model:\n  default: "op-model"\n  max_tokens: 8000\n',
        );
        writePerTaskHermesConfig({
          hermesHome: taskHome,
          workingDir: '/work',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          seedFrom: operatorHome,
        });
        const cfg = readConfig(taskHome);
        expect(cfg.model.max_tokens).toBe(8000);
      } finally {
        rmSync(operatorHome, { recursive: true, force: true });
        rmSync(taskHome, { recursive: true, force: true });
      }
    });
  });

  // JINN_HERMES_MODEL / JINN_HERMES_PROVIDER (daemon OS env) must win over the
  // per-SolverNet config value (`inputs.model` / `inputs.provider`), which wins
  // over ~/.hermes/config.yaml. Precedence bug #543: the SolverNet config value
  // silently won because writePerTaskHermesConfig stamped `inputs.model` directly.
  describe('JINN_HERMES_MODEL / JINN_HERMES_PROVIDER env precedence', () => {
    it('uses the env vars when no per-SolverNet model/provider is supplied', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          processEnv: { JINN_HERMES_MODEL: 'env-model', JINN_HERMES_PROVIDER: 'env-provider' },
        });
        const cfg = readConfig(home);
        expect(cfg.model.default).toBe('env-model');
        expect(cfg.model.provider).toBe('env-provider');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('uses the per-SolverNet config value when no env vars are set', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          model: 'config-model',
          provider: 'config-provider',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          processEnv: {},
        });
        const cfg = readConfig(home);
        expect(cfg.model.default).toBe('config-model');
        expect(cfg.model.provider).toBe('config-provider');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('prefers the env vars over the per-SolverNet config value', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          model: 'config-model',
          provider: 'config-provider',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          processEnv: { JINN_HERMES_MODEL: 'env-model', JINN_HERMES_PROVIDER: 'env-provider' },
        });
        const cfg = readConfig(home);
        expect(cfg.model.default).toBe('env-model');
        expect(cfg.model.provider).toBe('env-provider');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('ignores empty/whitespace env vars and preserves the per-SolverNet config value', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          model: 'config-model',
          provider: 'config-provider',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          processEnv: { JINN_HERMES_MODEL: '   ', JINN_HERMES_PROVIDER: '' },
        });
        const cfg = readConfig(home);
        expect(cfg.model.default).toBe('config-model');
        expect(cfg.model.provider).toBe('config-provider');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('keeps the custom-endpoint provider when a base_url is set (env provider does not override)', () => {
      const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
      try {
        writePerTaskHermesConfig({
          hermesHome: home,
          workingDir: '/work',
          model: 'qwen2.5-coder:7b',
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:11434/v1',
          solverPluginRoots: [],
          env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
          processEnv: { JINN_HERMES_PROVIDER: 'env-provider' },
        });
        const cfg = readConfig(home);
        expect(cfg.model.provider).toBe('custom');
        expect(cfg.model.base_url).toBe('http://127.0.0.1:11434/v1');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  });

  it('skips seeding when seedFrom equals hermesHome or does not exist', () => {
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: taskHome,
      });
      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: join(tmpdir(), 'definitely-does-not-exist-' + Date.now()),
      });
      expect(existsSync(join(taskHome, 'config.yaml'))).toBe(true);
    } finally {
      rmSync(taskHome, { recursive: true, force: true });
    }
  });
});
