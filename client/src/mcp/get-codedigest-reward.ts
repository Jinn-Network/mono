import type { DiscoveryClient } from '../discovery-client/types.js';
import { DiscoveryUnavailableError } from '../discovery-client/types.js';

/**
 * Pure handler for the `get_codedigest_reward` MCP tool (#764). Returns a
 * structured result rather than throwing, so the MCP layer can surface a
 * machine-readable error.
 *
 * The `jinn codedigest-revert-check` CLI that used to be this tool's parity
 * surface was retired by one-swap R3b (issue #2494) — the HTTP indexer serves
 * no authenticated reward rows, so it could only ever report
 * `insufficient_samples`. This tool is now the sole reach into the read.
 */
export async function handleGetCodeDigestReward(
  discovery: Pick<DiscoveryClient, 'getCodeDigestRewards'> | null,
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
