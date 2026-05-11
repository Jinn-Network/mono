// client/test/harnesses/impls/hermes-agent/bootstrap.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
});
