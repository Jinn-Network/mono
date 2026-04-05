/**
 * x402 payment-gated artifact serving.
 * Adds payment middleware to Hono app for artifact content access.
 * Ported from protocol/src/x402/handler.ts.
 */

import type { Hono } from 'hono';
import { paymentMiddleware } from '@x402/hono';
import { x402ResourceServer } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';
import type { Network } from '@x402/core/types';
import type { Store } from '../store/store.js';
import { createLocalFacilitatorClient } from './facilitator.js';

export interface X402Config {
  privateKey: string;
  recipientAddress: string;
  pricePerArtifact?: string;  // default: '$0.001'
  network?: string;           // default: 'eip155:8453'
  rpcUrl?: string;
}

export function addX402Routes(app: Hono, store: Store, config: X402Config): void {
  const facilitatorClient = createLocalFacilitatorClient({
    privateKey: config.privateKey,
    network: config.network,
    rpcUrl: config.rpcUrl,
  });

  const network = (config.network ?? 'eip155:8453') as Network;
  const price = config.pricePerArtifact ?? '$0.001';

  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(resourceServer);

  const routes = {
    'GET /x402/artifacts/:id/content': {
      accepts: {
        scheme: 'exact',
        payTo: config.recipientAddress,
        price,
        network,
      },
      description: 'Access artifact content',
    },
  };

  app.use(paymentMiddleware(routes, resourceServer));

  app.get('/x402/artifacts/:id/content', async (c) => {
    const id = c.req.param('id');
    const content = store.getArtifactContent(id);
    if (content === null) return c.json({ error: 'Not found' }, 404);
    return c.json({ content });
  });
}
