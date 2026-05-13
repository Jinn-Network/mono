// client/test/harnesses/impls/hermes-agent/bootstrap.test.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writePerTaskHermesConfig } from '../../../../src/harnesses/impls/hermes-agent/bootstrap.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

describe('writePerTaskHermesConfig', () => {
  it('writes config.yaml with mcp_servers, skills, terminal, and toolset allowlist', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        model: 'anthropic/claude-opus-4.6',
        provider: 'anthropic',
        solverPluginRoots: [networkToolsRoot],
        env: {
          storePath: '/tmp/jinn.db',
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok',
          corpusEnv: {},
        },
      });

      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      expect(yaml).toContain('mcp_servers:');
      expect(yaml).toContain('jinn-client');
      expect(yaml).toContain('terminal:');
      expect(yaml).toContain('backend: local');
      expect(yaml).toContain('cwd: "/work"');
      expect(yaml).toContain('platform_toolsets:');
      expect(yaml).toContain('hermes-cli:');
      expect(yaml).toContain('- terminal');
      expect(yaml).toContain('- file');
      expect(yaml).toContain('- web');
      expect(yaml).toContain('- skills');
      expect(yaml).toContain('- memory');
      expect(yaml).toContain('- session_search');
      expect(yaml).toContain('- todo');
      expect(yaml).toContain('- code_execution');
      // Footgun toolsets MUST NOT appear
      expect(yaml).not.toContain('- messaging');
      expect(yaml).not.toContain('- cronjob');
      expect(yaml).not.toContain('- browser');
      expect(yaml).not.toContain('- computer_use');
      // Model block
      expect(yaml).toContain("default: \"anthropic/claude-opus-4.6\"");
      expect(yaml).toContain('provider: "anthropic"');
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
          corpusEnv: { subgraphUrl: 'https://subgraph.example/' },
        },
      });

      const envFile = readFileSync(join(home, '.env'), 'utf8');
      expect(envFile).toContain('DAEMON_API_TOKEN=tok-xyz');
      expect(envFile).toContain('DAEMON_API_URL=http://127.0.0.1:7331');
      expect(envFile).toContain('JINN_CORPUS_SUBGRAPH_URL=https://subgraph.example/');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('seeds auth/ and auth.json from the operator home into a fresh per-Task home', () => {
    const operatorHome = mkdtempSync(join(tmpdir(), 'hermes-operator-'));
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      // Simulate the operator's authenticated Hermes home.
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
      // Per-Task home already has its own (e.g. a frozen-mode snapshot restored it).
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
      // Operator has provider keys + a custom toggle that Jinn doesn't know about.
      writeFileSync(
        join(operatorHome, '.env'),
        [
          'OPENROUTER_API_KEY=sk-or-OP_KEY_REDACTED',
          'ANTHROPIC_API_KEY=sk-ant-OP_KEY_REDACTED',
          'OPERATOR_CUSTOM_FLAG=on',
          // Operator-set DAEMON_API_URL — Jinn must override this with its own.
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
      // Operator entries present.
      expect(envFile).toContain('OPENROUTER_API_KEY=sk-or-OP_KEY_REDACTED');
      expect(envFile).toContain('ANTHROPIC_API_KEY=sk-ant-OP_KEY_REDACTED');
      expect(envFile).toContain('OPERATOR_CUSTOM_FLAG=on');
      // Jinn DAEMON_API_URL appears after the operator's, so last-wins
      // semantics (python-dotenv default) give Jinn the override.
      const operatorIdx = envFile.indexOf('DAEMON_API_URL=http://operator-set:9999');
      const jinnIdx = envFile.indexOf('DAEMON_API_URL=http://127.0.0.1:7331');
      expect(operatorIdx).toBeGreaterThanOrEqual(0);
      expect(jinnIdx).toBeGreaterThan(operatorIdx);
      // Jinn-runtime credentials still present.
      expect(envFile).toContain('DAEMON_API_TOKEN=tok-jinn');
    } finally {
      rmSync(operatorHome, { recursive: true, force: true });
      rmSync(taskHome, { recursive: true, force: true });
    }
  });

  it('skips seeding when seedFrom equals hermesHome or does not exist', () => {
    const taskHome = mkdtempSync(join(tmpdir(), 'hermes-task-'));
    try {
      // Same path — must not recurse-copy onto itself.
      writePerTaskHermesConfig({
        hermesHome: taskHome,
        workingDir: '/work',
        solverPluginRoots: [],
        env: { daemonApiUrl: 'http://127.0.0.1:7331', daemonApiToken: 'tok', corpusEnv: {} },
        seedFrom: taskHome,
      });
      // Nonexistent source — must not throw.
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
