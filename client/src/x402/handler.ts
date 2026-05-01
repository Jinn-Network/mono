/**
 * x402 payment-gated artifact serving.
 *
 * Single route, dynamic per-row price (spec/2026-04-30-phase-a-umbrella.md §5.4):
 *   priceUsdc='0'  → respond 200 immediately, no payment dance.
 *   priceUsdc>'0'  → emit 402 with payment requirements built from the row's
 *                    price; on valid X-PAYMENT, verify + settle via local
 *                    facilitator, then 200.
 *
 * The route is keyed by sha256, matching the artifact identifier in the signed
 * envelope (post jinn-mono-vy37.1.2 — artifacts no longer have IPFS CIDs).
 */

import type { Hono, Context } from 'hono';
import type { Network } from '@x402/core/types';
import type { Store } from '../store/store.js';
import { createLocalFacilitatorClient } from './facilitator.js';

export interface X402Config {
  privateKey: string;
  recipientAddress: string;
  /** Default 'eip155:8453' (Base mainnet). */
  network?: string;
  rpcUrl?: string;
  /**
   * @deprecated price comes from served_artifacts.priceUsdc per row; this
   * field is ignored. Kept on the type for one cycle of caller compat.
   */
  pricePerArtifact?: string;
}

function dollarStringFromUsdc(usdc: string): string {
  // X402 'exact' scheme expects a string like '$0.001' for USDC amounts.
  return `$${usdc}`;
}

function mimeForArtifactType(artifactType: string | undefined): string {
  if (!artifactType) return 'application/octet-stream';
  const t = artifactType.toLowerCase();
  if (t.includes('markdown') || t.includes('.md')) return 'text/markdown';
  if (t.includes('tar') || t.includes('gz')) return 'application/gzip';
  return 'application/octet-stream';
}

export function addX402Routes(app: Hono, store: Store, config: X402Config): void {
  const facilitator = createLocalFacilitatorClient({
    privateKey: config.privateKey,
    network: config.network,
    rpcUrl: config.rpcUrl,
  });

  const network = (config.network ?? 'eip155:8453') as Network;

  app.get('/v1/artifacts/:sha256/content', async (c: Context) => {
    const sha256 = c.req.param('sha256');
    if (!sha256) return c.json({ error: 'Missing sha256' }, 400);
    const row = store.getServedArtifact(sha256);
    if (!row) return c.json({ error: 'Not found' }, 404);

    if (row.priceUsdc === '0') {
      c.header('Content-Type', mimeForArtifactType(row.artifactType));
      c.header('X-Artifact-Type', row.artifactType ?? '');
      return c.body(new Uint8Array(row.content));
    }

    // Paid path
    const accepts = [{
      scheme: 'exact',
      payTo: config.recipientAddress,
      price: dollarStringFromUsdc(row.priceUsdc),
      network,
      description: `artifact ${sha256.slice(0, 12)}…`,
    }];

    const xPayment = c.req.header('X-Payment');
    if (!xPayment) {
      return c.json({ accepts }, 402);
    }

    try {
      const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf-8')) as {
        scheme: string;
        payload: unknown;
      };
      const requirement = accepts.find((a) => a.scheme === decoded.scheme);
      if (!requirement) {
        return c.json({ error: 'Unsupported payment scheme', accepts }, 402);
      }
      const verification = await facilitator.verify(decoded.payload as never, requirement as never);
      if (!verification.isValid) {
        return c.json({ error: verification.invalidReason ?? 'Payment verification failed', accepts }, 402);
      }
      const settlement = await facilitator.settle(decoded.payload as never, requirement as never);
      if (!settlement.success) {
        return c.json({ error: settlement.errorReason ?? 'Settlement failed', accepts }, 402);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Payment validation error: ${msg}`, accepts }, 402);
    }

    c.header('Content-Type', mimeForArtifactType(row.artifactType));
    c.header('X-Artifact-Type', row.artifactType ?? '');
    return c.body(new Uint8Array(row.content));
  });
}
