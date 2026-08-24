import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANIFEST_LOOKUP_ORDER,
  loadSolverPluginManifest,
  resolveSolverPlugin,
} from '../../src/plugins/index.js';

const pluginRoot = fileURLToPath(new URL('../../plugins/network-tools/', import.meta.url));
const networkTools = [
  'search_records',
  'inspect_record',
  'acquire_artifact',
  'get_task',
] as const;

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(pluginRoot, rel), 'utf-8')) as Record<string, unknown>;
}

describe('Network Tools plugin manifest', () => {
  it('loads as a Jinn manifest without claiming SolverNet protocol authority', () => {
    const { path, manifest } = loadSolverPluginManifest(pluginRoot);

    expect(path.endsWith('jinn.plugin.json')).toBe(true);
    expect(manifest.name).toBe('@jinn-network/network-tools');
    expect(manifest.description).toContain('Network Tools');
    expect(manifest.description).toContain('SolverNet contracts remain the canonical');
    expect(manifest.jinn.supports).toEqual(['jinn.runtime']);
    expect(manifest.jinn).not.toHaveProperty('schemas');
    expect(manifest.jinn).not.toHaveProperty('solverType');
  });

  it('declares the shared runtime MCP tool surface by name', () => {
    const manifest = readJson('jinn.plugin.json');
    const jinn = manifest.jinn as Record<string, unknown>;
    const capabilities = jinn.capabilities as Record<string, Record<string, string[]>>;
    const servers = jinn.mcpServers as Record<string, { providedBy: string; tools: string[] }>;

    expect(capabilities.tools['jinn-runtime']).toEqual([...networkTools]);
    expect(servers['jinn-runtime']).toMatchObject({
      providedBy: 'jinn-client-runtime',
      tools: [...networkTools],
    });
  });

  it('declares a portable Claude Code MCP server entrypoint', () => {
    const manifest = readJson('.claude-plugin/plugin.json');
    const servers = manifest.mcpServers as Record<string, { command: string; args: string[]; cwd: string }>;

    expect(manifest).not.toHaveProperty('jinn');
    expect(servers['jinn-client']).toEqual({
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/mcp/jinn-client-server.mjs'],
      cwd: '${CLAUDE_PLUGIN_ROOT}',
    });
    expect(existsSync(join(pluginRoot, 'mcp/jinn-client-server.mjs'))).toBe(true);
  });

  it('declares Codex host metadata without entering Jinn manifest lookup', () => {
    const codexManifest = readJson('.codex-plugin/plugin.json');
    const mcpManifest = readJson('.mcp.json');

    expect(MANIFEST_LOOKUP_ORDER).not.toContain('.codex-plugin/plugin.json');
    expect(loadSolverPluginManifest(pluginRoot).path.endsWith('jinn.plugin.json')).toBe(true);
    expect(codexManifest).not.toHaveProperty('jinn');
    expect(codexManifest).toMatchObject({
      name: 'network-tools',
      mcpServers: './.mcp.json',
    });
    expect(mcpManifest).toMatchObject({
      mcpServers: {
        'jinn-client': {
          command: 'node',
          args: ['mcp/jinn-client-server.mjs'],
          cwd: '.',
        },
      },
    });
  });

  it('resolves the plugin-local MCP wrapper to the existing client MCP server', async () => {
    const wrapper = await import(pathToFileURL(join(pluginRoot, 'mcp/jinn-client-server.mjs')).href) as {
      resolveJinnClientMcpLauncher: (
        env?: Record<string, string | undefined>,
        root?: string,
      ) => { command: string; args: string[]; cwd: string };
    };
    const clientRoot = mkdtempSync(join(tmpdir(), 'network-tools-client-'));
    const copiedPluginRoot = mkdtempSync(join(tmpdir(), 'network-tools-plugin-'));
    try {
      mkdirSync(join(clientRoot, 'dist', 'mcp'), { recursive: true });
      writeFileSync(join(clientRoot, 'dist', 'mcp', 'server.js'), '');

      const launcher = wrapper.resolveJinnClientMcpLauncher({
        JINN_NETWORK_TOOLS_CLIENT_ROOT: clientRoot,
      }, copiedPluginRoot);

      expect(launcher).toEqual({
        command: process.execPath,
        args: [join(clientRoot, 'dist', 'mcp', 'server.js')],
        cwd: clientRoot,
      });
    } finally {
      rmSync(clientRoot, { recursive: true, force: true });
      rmSync(copiedPluginRoot, { recursive: true, force: true });
    }
  });

  it('prefers compiled MCP server output over source when both exist', async () => {
    const wrapper = await import(pathToFileURL(join(pluginRoot, 'mcp/jinn-client-server.mjs')).href) as {
      resolveJinnClientMcpLauncher: (
        env?: Record<string, string | undefined>,
        root?: string,
      ) => { command: string; args: string[]; cwd: string };
    };
    const clientRoot = mkdtempSync(join(tmpdir(), 'network-tools-client-'));
    const copiedPluginRoot = mkdtempSync(join(tmpdir(), 'network-tools-plugin-'));
    try {
      mkdirSync(join(clientRoot, 'dist', 'mcp'), { recursive: true });
      mkdirSync(join(clientRoot, 'src', 'mcp'), { recursive: true });
      writeFileSync(join(clientRoot, 'dist', 'mcp', 'server.js'), '');
      writeFileSync(join(clientRoot, 'src', 'mcp', 'server.ts'), '');

      const launcher = wrapper.resolveJinnClientMcpLauncher({
        JINN_NETWORK_TOOLS_CLIENT_ROOT: clientRoot,
      }, copiedPluginRoot);

      expect(launcher).toEqual({
        command: process.execPath,
        args: [join(clientRoot, 'dist', 'mcp', 'server.js')],
        cwd: clientRoot,
      });
    } finally {
      rmSync(clientRoot, { recursive: true, force: true });
      rmSync(copiedPluginRoot, { recursive: true, force: true });
    }
  });

  it('uses source MCP server only when compiled output is absent', async () => {
    const wrapper = await import(pathToFileURL(join(pluginRoot, 'mcp/jinn-client-server.mjs')).href) as {
      resolveJinnClientMcpLauncher: (
        env?: Record<string, string | undefined>,
        root?: string,
      ) => { command: string; args: string[]; cwd: string };
    };
    const clientRoot = mkdtempSync(join(tmpdir(), 'network-tools-client-'));
    const copiedPluginRoot = mkdtempSync(join(tmpdir(), 'network-tools-plugin-'));
    try {
      mkdirSync(join(clientRoot, 'src', 'mcp'), { recursive: true });
      writeFileSync(join(clientRoot, 'src', 'mcp', 'server.ts'), '');

      const sourceLauncher = wrapper.resolveJinnClientMcpLauncher({
        JINN_NETWORK_TOOLS_CLIENT_ROOT: clientRoot,
      }, copiedPluginRoot);

      expect(sourceLauncher).toEqual({
        command: process.execPath,
        args: ['--import', 'tsx', join(clientRoot, 'src', 'mcp', 'server.ts')],
        cwd: clientRoot,
      });
    } finally {
      rmSync(clientRoot, { recursive: true, force: true });
      rmSync(copiedPluginRoot, { recursive: true, force: true });
    }
  });

  it('resolves bundled network-tools in place and finds the MCP server without JINN_NETWORK_TOOLS_CLIENT_ROOT', async () => {
    const vendorRoot = mkdtempSync(join(tmpdir(), 'network-tools-'));
    try {
      const plugin = await resolveSolverPlugin('bundled:network-tools', { vendorRoot });

      expect(plugin.name).toBe('@jinn-network/network-tools');
      expect(plugin.sourceKind).toBe('bundled');
      expect(plugin.source).toBe('bundled:network-tools');
      expect(resolve(plugin.root)).toBe(resolve(pluginRoot));
      expect(plugin.root.startsWith(vendorRoot)).toBe(false);
      expect(plugin.supports).toEqual(['jinn.runtime']);
      expect(existsSync(join(plugin.root, 'mcp/jinn-client-server.mjs'))).toBe(true);

      const wrapper = await import(pathToFileURL(join(plugin.root, 'mcp/jinn-client-server.mjs')).href) as {
        resolveJinnClientMcpLauncher: (
          env?: Record<string, string | undefined>,
          root?: string,
        ) => { command: string; args: string[]; cwd: string };
      };
      const launcher = wrapper.resolveJinnClientMcpLauncher({}, plugin.root);
      expect(existsSync(launcher.args.at(-1)!)).toBe(true);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });
});
