import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSolverPluginManifest } from '../../../src/plugins/manifest.js';
import { digestDirectory } from '../../../src/plugins/digest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('swe-rebench-v2-diffmin manifest (r83r)', () => {
  it('has a valid jinn.plugin.json that loadSolverPluginManifest parses', () => {
    const { manifest } = loadSolverPluginManifest(ROOT);
    expect(manifest.name).toBe('swe-rebench-v2-diffmin');
    expect(manifest.jinn.supports).toContain('swe-rebench-v2.v1');
    expect(manifest.jinn.skills?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('passes the SolverType-plugin validator (no jinn.runtime in supports)', () => {
    const { manifest } = loadSolverPluginManifest(ROOT);
    // SolverType mode: supports must not include 'jinn.runtime'
    expect(manifest.jinn.supports).not.toContain('jinn.runtime');
    // Every entry must be a SolverType identifier
    for (const entry of manifest.jinn.supports) {
      expect(typeof entry).toBe('string');
      expect(entry.length).toBeGreaterThan(0);
    }
  });

  it('declares an .mcp.json that points at the bundled diff-stats server', () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers).toBeDefined();
    expect(mcp.mcpServers['diff-stats']).toBeDefined();
    expect(mcp.mcpServers['diff-stats'].command).toBe('node');
    expect(mcp.mcpServers['diff-stats'].args?.[0]).toContain('mcp/diff-stats-server.mjs');
  });

  it('every declared skill file exists with non-empty frontmatter', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'jinn.plugin.json'), 'utf8'));
    for (const skill of manifest.jinn.skills) {
      const p = join(ROOT, skill);
      expect(existsSync(p), `missing skill file: ${skill}`).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body, `empty skill: ${skill}`).toMatch(/^---[\s\S]+name:\s*\S+[\s\S]+description:\s*\S+[\s\S]+---/);
      // Reject placeholder content — this plug-in must be real.
      expect(body, `placeholder content in ${skill}`).not.toMatch(/Replace this body|placeholder/i);
    }
  });

  it('digestDirectory produces a stable sha256 for the package contents', () => {
    const digest = digestDirectory(ROOT);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
