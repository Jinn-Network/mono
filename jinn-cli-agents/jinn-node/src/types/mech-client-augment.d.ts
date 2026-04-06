import type { KeyConfig } from '@jinn-network/mech-client-ts/dist/config.js';

declare module '@jinn-network/mech-client-ts/dist/marketplace_interact.js' {
  interface MarketplaceInteractOptions {
    keyConfig?: KeyConfig;
    responseTimeout?: number;
  }
}
