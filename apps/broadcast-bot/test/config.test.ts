import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

function withConfig(toml: string, fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-bcast-config-'));
  try {
    const path = join(dir, 'config.toml');
    writeFileSync(path, toml);
    fn(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('loadConfig', () => {
  it('parses a minimal valid config and applies defaults', () => {
    withConfig(
      `[github]
repo = "Jinn-Network/mono"
sources = ["releases"]
`,
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.github.repo).toBe('Jinn-Network/mono');
        expect(cfg.github.sources).toEqual(['releases']);
        expect(cfg.composer.model).toBe('claude-sonnet-4-6');
        expect(cfg.composer.maxChars).toBe(240);
        expect(cfg.poster.backend).toBe('x');
      },
    );
  });

  it('converts snake_case TOML keys to camelCase Zod schema', () => {
    withConfig(
      `[github]
repo = "Jinn-Network/mono"
sources = ["prs"]

[github.prs]
base_branches = ["main"]
exclude_authors = ["botty"]
exclude_prefixes = ["wip"]
`,
      (path) => {
        const cfg = loadConfig(path);
        expect(cfg.github.prs.baseBranches).toEqual(['main']);
        expect(cfg.github.prs.excludeAuthors).toEqual(['botty']);
        expect(cfg.github.prs.excludePrefixes).toEqual(['wip']);
      },
    );
  });

  it('rejects a malformed repo string', () => {
    withConfig(
      `[github]
repo = "not-an-owner-repo"
sources = []
`,
      (path) => {
        expect(() => loadConfig(path)).toThrow();
      },
    );
  });

  it('honors JINN_RPC_URL env override for onchain.rpcUrl', () => {
    withConfig(
      `[github]
repo = "Jinn-Network/mono"
sources = []

[onchain]
enabled = true
rpc_url = "https://configured.example"
chain_id = 84532

[onchain.contracts]
identity_registry = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
`,
      (path) => {
        const prev = process.env['JINN_RPC_URL'];
        process.env['JINN_RPC_URL'] = 'https://env-override.example';
        try {
          const cfg = loadConfig(path);
          expect(cfg.onchain.rpcUrl).toBe('https://env-override.example');
        } finally {
          if (prev === undefined) delete process.env['JINN_RPC_URL'];
          else process.env['JINN_RPC_URL'] = prev;
        }
      },
    );
  });
});
