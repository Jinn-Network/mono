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
import type { ArtifactAccessEventInput, ArtifactAccessOutcome, Store } from '../store/store.js';
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

function requestMeta(c: Context): Pick<ArtifactAccessEventInput, 'remoteAddr' | 'userAgent'> {
  return {
    remoteAddr:
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? c.req.header('cf-connecting-ip')
      ?? null,
    userAgent: c.req.header('user-agent') ?? null,
  };
}

function stringFromRecord(value: unknown, keys: string[]): string | null {
  let current = value;
  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' && current.length > 0 ? current : null;
}

function payerFromPayload(payload: unknown): string | null {
  return (
    stringFromRecord(payload, ['payload', 'authorization', 'from'])
    ?? stringFromRecord(payload, ['payload', 'permit2Authorization', 'owner'])
    ?? stringFromRecord(payload, ['payer'])
  );
}

function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function safeRecordAccess(store: Store, input: ArtifactAccessEventInput): void {
  try {
    store.recordArtifactAccessEvent(input);
  } catch (err) {
    console.warn(
      `[x402] Failed to record artifact access event for ${input.sha256}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
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
    if (!row) {
      safeRecordAccess(store, {
        sha256,
        artifactType: null,
        priceUsdc: null,
        outcome: 'not_found',
        httpStatus: 404,
        createdAt: new Date().toISOString(),
        ...requestMeta(c),
      });
      return c.json({ error: 'Not found' }, 404);
    }

    if (row.priceUsdc === '0') {
      safeRecordAccess(store, {
        sha256,
        artifactType: row.artifactType,
        priceUsdc: row.priceUsdc,
        outcome: 'free_served',
        httpStatus: 200,
        createdAt: new Date().toISOString(),
        ...requestMeta(c),
      });
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
      safeRecordAccess(store, {
        sha256,
        artifactType: row.artifactType,
        priceUsdc: row.priceUsdc,
        outcome: 'payment_required',
        httpStatus: 402,
        createdAt: new Date().toISOString(),
        ...requestMeta(c),
      });
      return c.json({ accepts }, 402);
    }

    let decoded: { scheme: string; payload: unknown };
    try {
      decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf-8')) as {
        scheme: string;
        payload: unknown;
      };
      const requirement = accepts.find((a) => a.scheme === decoded.scheme);
      if (!requirement) {
        safeRecordAccess(store, {
          sha256,
          artifactType: row.artifactType,
          priceUsdc: row.priceUsdc,
          outcome: 'payment_malformed',
          httpStatus: 402,
          payer: payerFromPayload(decoded.payload),
          errorReason: 'unsupported_payment_scheme',
          createdAt: new Date().toISOString(),
          ...requestMeta(c),
        });
        return c.json({ error: 'Unsupported payment scheme', accepts }, 402);
      }
      const verification = await facilitator.verify(decoded.payload as never, requirement as never);
      if (!verification.isValid) {
        const reason = verification.invalidReason ?? 'Payment verification failed';
        safeRecordAccess(store, {
          sha256,
          artifactType: row.artifactType,
          priceUsdc: row.priceUsdc,
          outcome: 'verification_failed',
          httpStatus: 402,
          payer: stringField(verification, 'payer') ?? payerFromPayload(decoded.payload),
          errorReason: reason,
          createdAt: new Date().toISOString(),
          ...requestMeta(c),
        });
        return c.json({ error: reason, accepts }, 402);
      }
      const settlement = await facilitator.settle(decoded.payload as never, requirement as never);
      if (!settlement.success) {
        const reason = settlement.errorReason ?? 'Settlement failed';
        safeRecordAccess(store, {
          sha256,
          artifactType: row.artifactType,
          priceUsdc: row.priceUsdc,
          outcome: 'settlement_failed',
          httpStatus: 402,
          payer: stringField(settlement, 'payer') ?? stringField(verification, 'payer') ?? payerFromPayload(decoded.payload),
          settlementTx: stringField(settlement, 'transaction'),
          errorReason: reason,
          createdAt: new Date().toISOString(),
          ...requestMeta(c),
        });
        return c.json({ error: reason, accepts }, 402);
      }
      safeRecordAccess(store, {
        sha256,
        artifactType: row.artifactType,
        priceUsdc: row.priceUsdc,
        outcome: 'paid_served',
        httpStatus: 200,
        payer: stringField(settlement, 'payer') ?? stringField(verification, 'payer') ?? payerFromPayload(decoded.payload),
        settlementTx: stringField(settlement, 'transaction'),
        createdAt: new Date().toISOString(),
        ...requestMeta(c),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      safeRecordAccess(store, {
        sha256,
        artifactType: row.artifactType,
        priceUsdc: row.priceUsdc,
        outcome: 'payment_malformed' satisfies ArtifactAccessOutcome,
        httpStatus: 402,
        errorReason: msg,
        createdAt: new Date().toISOString(),
        ...requestMeta(c),
      });
      return c.json({ error: `Payment validation error: ${msg}`, accepts }, 402);
    }

    c.header('Content-Type', mimeForArtifactType(row.artifactType));
    c.header('X-Artifact-Type', row.artifactType ?? '');
    return c.body(new Uint8Array(row.content));
  });
}
