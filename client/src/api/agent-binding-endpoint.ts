/**
 * POST /v1/setup/agent-binding/retry — re-runs the ERC-1271 bind step
 * for any service whose Safe is not yet bound to its agent NFT.
 *
 * The bootstrap correctly continues with `safe_bound_to_agent=false` when
 * the bind reverts (jinn-mono-aev), so onboarding doesn't halt — but the
 * binding silently goes missing. This endpoint exists so the operator app
 * can offer a one-click retry without forcing a full daemon restart.
 *
 * Filed alongside the contract-side investigation of *why* the bind reverts
 * against fresh 1/1 Safes on Base Sepolia (`bd jinn-mono-h74p`).
 */
import type { Hono } from 'hono';

export interface BindAttemptResult {
  serviceIndex: number;
  status: 'success' | 'reverted' | 'queued';
  txHash?: string;
  detail?: string;
}

export interface AgentBindingRoutesConfig {
  retryBind(serviceIndex: number): Promise<BindAttemptResult>;
  listUnbound(): Promise<Array<{ serviceIndex: number }>>;
}

export function addAgentBindingRoutes(app: Hono, config: AgentBindingRoutesConfig): void {
  app.post('/v1/setup/agent-binding/retry', async (c) => {
    let body: { serviceIndex?: unknown } = {};
    try {
      body = await c.req.json();
    } catch {
      // empty body is allowed — defaults to "all unbound services"
    }

    let targets: Array<{ serviceIndex: number }>;
    if (body.serviceIndex !== undefined) {
      if (typeof body.serviceIndex !== 'number' || !Number.isInteger(body.serviceIndex)) {
        return c.json({ error: 'invalid_body', detail: '`serviceIndex` must be an integer' }, 400);
      }
      targets = [{ serviceIndex: body.serviceIndex }];
    } else {
      targets = await config.listUnbound();
    }

    const attempts: BindAttemptResult[] = [];
    for (const target of targets) {
      const result = await config.retryBind(target.serviceIndex);
      attempts.push(result);
    }
    return c.json({ ok: true, attempts });
  });
}
