import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRpcUrls } from '../src/transport.js';

// Resolve deploy/.env.example relative to this test file so the test is
// portable across checkouts / worktrees (no hardcoded absolute path).
const here = path.dirname(fileURLToPath(import.meta.url));
const envExamplePath = path.resolve(here, '..', 'deploy', '.env.example');

/** Read the value of `name=` from .env.example, ignoring full-line `#` comments. */
function readEnvValue(contents: string, name: string): string {
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    if (line.slice(0, eq) === name) return line.slice(eq + 1);
  }
  throw new Error(`${name} not found in .env.example`);
}

describe('claim-relayer deploy/.env.example RPC durability (#1071)', () => {
  const contents = readFileSync(envExamplePath, 'utf8');

  it('ships a multi-provider L1 RPC fallback chain (>= 3 providers, #1068)', () => {
    const value = readEnvValue(contents, 'JINN_CLAIM_RELAYER_L1_RPC_URL');
    const chain = parseRpcUrls(value);
    expect(chain.length).toBeGreaterThanOrEqual(3);
  });

  it('ships a multi-provider L2 RPC fallback chain (>= 2 providers)', () => {
    const value = readEnvValue(contents, 'JINN_CLAIM_RELAYER_L2_RPC_URL');
    const chain = parseRpcUrls(value);
    expect(chain.length).toBeGreaterThanOrEqual(2);
  });
});
