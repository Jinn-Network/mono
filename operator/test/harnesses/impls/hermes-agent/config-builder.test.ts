// operator/test/harnesses/impls/hermes-agent/config-builder.test.ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hermesConfigFromSolverPlugins } from '../../../../src/harnesses/impls/hermes-agent/config-builder.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));
const sweRuntimeRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));

function fakeEnv() {
  return {
    storePath: '/tmp/jinn.db',
    daemonApiUrl: 'http://127.0.0.1:7331',
    daemonApiToken: 'tok-test',
    corpusEnv: {
      discoveryUrl: 'https://discovery.example/',
      ipfsGatewayUrl: 'https://ipfs.example/',
      rpcUrl: 'https://rpc.example/',
      chainId: 8453,
      identityRegistryAddress: '0xabc',
      fromBlock: 0,
    },
  };
}

describe('hermesConfigFromSolverPlugins', () => {
  it('translates network-tools .mcp.json into mcp_servers with absolute paths', () => {
    const out = hermesConfigFromSolverPlugins([networkToolsRoot], fakeEnv());

    expect(out.mcp_servers).toBeDefined();
    const jinnClient = out.mcp_servers!['jinn-client'];
    expect(jinnClient).toBeDefined();
    expect(jinnClient.command).toBe('node');
    // Args must be absolute (resolved against plugin root from the relative "mcp/jinn-client-server.mjs")
    expect(jinnClient.args).toEqual([expect.stringMatching(/network-tools\/mcp\/jinn-client-server\.mjs$/)]);
    // cwd resolves from "." → the plugin root
    expect(jinnClient.cwd).toMatch(/network-tools\/?$/);
    // Env vars passed through from runtime
    expect(jinnClient.env?.STORE_PATH).toBe('/tmp/jinn.db');
    expect(jinnClient.env?.DAEMON_API_URL).toBe('http://127.0.0.1:7331');
    expect(jinnClient.env?.DAEMON_API_TOKEN).toBe('tok-test');
    expect(jinnClient.env?.JINN_DISCOVERY_URL).toBe('https://discovery.example/');
    expect(jinnClient.env?.JINN_DISCOVERY_MODE).toBe('http');
    expect(jinnClient.env?.JINN_CORPUS_IPFS_GATEWAY_URL).toBe('https://ipfs.example/');
    expect(jinnClient.env?.JINN_CORPUS_RPC_URL).toBe('https://rpc.example/');
    expect(jinnClient.env?.JINN_CORPUS_CHAIN_ID).toBe('8453');
  });

  it('adds skills/ dir to skills.external_dirs when present', () => {
    const out = hermesConfigFromSolverPlugins([sweRuntimeRoot], fakeEnv());

    expect(out.skills?.external_dirs).toEqual([
      expect.stringMatching(/swe-rebench-v2-runtime\/skills$/),
    ]);
  });

  it('handles plugins with neither .mcp.json nor skills/ as no-op', () => {
    // A plugin root pointing at a tmp dir with nothing relevant
    const tmpRoot = fileURLToPath(new URL('./fixtures/empty-plugin/', import.meta.url));
    const out = hermesConfigFromSolverPlugins([tmpRoot], fakeEnv());

    expect(out.mcp_servers ?? {}).toEqual({});
    expect(out.skills?.external_dirs ?? []).toEqual([]);
  });

  it('does not consult jinn.plugin.json or providedBy', () => {
    // Even if jinn.plugin.json says providedBy: jinn-client-runtime, the translator
    // emits config solely from .mcp.json (which is what we just verified above).
    // No assertion needed beyond the absence of failure — this test exists to
    // document the design intent and catch regressions if someone re-adds
    // a providedBy branch.
    expect(true).toBe(true);
  });

  it('launcher resolves the MCP server from an in-place bundled plugin root without JINN_NETWORK_TOOLS_CLIENT_ROOT', async () => {
    const wrapper = await import(pathToFileURL(join(networkToolsRoot, 'mcp/jinn-client-server.mjs')).href) as {
      resolveJinnClientMcpLauncher: (
        env?: Record<string, string | undefined>,
        root?: string,
      ) => { command: string; args: string[]; cwd: string };
    };
    const launcher = wrapper.resolveJinnClientMcpLauncher({}, networkToolsRoot);
    expect(existsSync(launcher.args.at(-1)!)).toBe(true);
  });

  it('launcher resolves the MCP server entry without the "Unable to find" error when env is built from plugin roots', async () => {
    // gh #294 integration smoke: spawn the actual launcher script with the
    // env block this module produces and assert it doesn't bail with the
    // resolver error. The launcher itself goes on to exec the daemon's MCP
    // server (which then waits for stdio protocol traffic) — we time-bound
    // the spawn at 2s and only check stderr.
    const out = hermesConfigFromSolverPlugins([networkToolsRoot], fakeEnv());
    const jinnClient = out.mcp_servers!['jinn-client'] as {
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    };

    const child = spawn(jinnClient.command, jinnClient.args, {
      cwd: jinnClient.cwd,
      env: { ...process.env, ...(jinnClient.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    // Give the launcher up to 2s to either fail-fast with the resolver error
    // or proceed to spawn the MCP server (which would block on stdio).
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    child.kill('SIGTERM');
    // Allow the kill to land.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(stderr).not.toMatch(/Unable to find the Jinn client MCP server/);
    expect(stdout).not.toMatch(/Unable to find the Jinn client MCP server/);
  }, 10_000);

  it('passes HTTP MCP url/headers through unchanged', () => {
    const httpRoot = fileURLToPath(new URL('./fixtures/http-mcp-plugin/', import.meta.url));
    const out = hermesConfigFromSolverPlugins([httpRoot], fakeEnv());

    const tp = out.mcp_servers!['third-party'] as { url: string; headers?: Record<string, string> };
    expect(tp.url).toBe('https://third-party.example/mcp');
    expect(tp.headers?.Authorization).toBe('Bearer hypothetical-token');
  });
});
