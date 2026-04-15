/**
 * Shared utility functions for tests
 * Migrated from tests/helpers/shared.ts
 */

import fetch from 'cross-fetch';

/**
 * Reconstruct IPFS directory CID from hex ipfsHash (raw codec)
 */
function hexToBytes(hex: string): number[] {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

function toBase32LowerNoPad(bytes: number[]): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bitBuffer = 0;
  let bitCount = 0;
  let out = '';
  for (const b of bytes) {
    bitBuffer = (bitBuffer << 8) | (b & 0xff);
    bitCount += 8;
    while (bitCount >= 5) {
      const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
      bitCount -= 5;
      out += alphabet[idx];
    }
  }
  if (bitCount > 0) {
    const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
    out += alphabet[idx];
  }
  return out;
}

export function reconstructDirCidFromHexIpfsHash(ipfsHashHex: string): string | null {
  const s = String(ipfsHashHex).toLowerCase();
  const prefix = 'f01551220';
  if (!s.startsWith(prefix)) return null;
  const digestHex = s.slice(prefix.length);
  if (digestHex.length !== 64) return null;
  const digestBytes = hexToBytes(digestHex);
  const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
  return 'b' + toBase32LowerNoPad(cidBytes);
}

/**
 * Fetch JSON from URL with retries
 */
export async function fetchJsonWithRetry(url: string, attempts = 5, delayMs = 1500): Promise<any> {
  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await fetch(url);
      if (resp.ok) return await resp.json();
    } catch {}
    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Failed to fetch JSON from ${url}`);
}

/**
 * Reset test environment state between tests to prevent leakage
 * Call this in beforeEach() to ensure clean state
 *
 * NOTE: Does NOT disconnect/reconnect MCP client to avoid breaking active connections.
 * Tests that modify env vars and need MCP to see them should disconnect/reconnect manually.
 */
export function resetTestEnvironment(): void {
  // Clear lineage context that may have been set by previous tests
  delete process.env.JINN_REQUEST_ID;
  delete process.env.JINN_JOB_DEFINITION_ID;

  // Note: MCP client is intentionally left connected and shared across tests.
  // This avoids breaking connections during test execution.
  // Tests that set env vars for MCP must manually disconnect/reconnect.
}
