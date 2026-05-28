import type { DiscoveryAPI } from '../discovery/types.js';
import { DiscoveryUnavailableError } from '../discovery/types.js';

/**
 * Pure handler for the `get_codedigest_reward` MCP tool (#764). Shares no logic
 * with the CLI beyond the DiscoveryAPI call, so the two parity surfaces cannot
 * drift on the query/aggregation shape. Returns a structured result rather than
 * throwing, so the MCP layer can surface a machine-readable error.
 */
export async function handleGetCodeDigestReward(
  discovery: DiscoveryAPI | null,
  args: { codeDigests: string[]; operator?: `0x${string}`; solverNetManifestCid?: string; window?: number },
): Promise<Record<string, unknown>> {
  if (!discovery) {
    return { ok: false, error: { kind: 'no_discovery', message: 'discovery not configured' }, rows: [] };
  }
  try {
    const rows = await discovery.getCodeDigestRewards(args);
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof DiscoveryUnavailableError) {
      return { ok: false, error: { kind: 'discovery_unavailable', message: err.message }, rows: [] };
    }
    throw err;
  }
}
