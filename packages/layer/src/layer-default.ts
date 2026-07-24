import { createHarnessLayer, type HarnessLayer } from './consume.js';

/** Shared environment-resolved corpus layer for CLI and plugin composition. */
export function buildDefaultLayer(): HarnessLayer {
  return createHarnessLayer({
    ...(process.env['JINN_DISCOVERY_URL'] ? { discoveryUrl: process.env['JINN_DISCOVERY_URL'] } : {}),
    ...(process.env['JINN_IPFS_GATEWAY_URL']
      ? { ipfsGatewayUrl: process.env['JINN_IPFS_GATEWAY_URL'] }
      : {}),
  });
}
