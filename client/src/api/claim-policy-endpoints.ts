/**
 * Claim policy & wiring endpoints (OPERATOR-APP-SPEC §2.15).
 *
 *   GET /v1/operator/claim-policy          -> { claimPolicy, executionWiring, restartRequired }
 *   PUT /v1/operator/claim-policy          -> body { claimPolicy }; 400 on schema failure
 *   PUT /v1/operator/execution-wiring      -> body { executionWiring }; 400 on schema failure
 *
 * Both PUT routes write the *whole* config file back through `writeConfig`
 * (mirroring `writeConfigFileAtomic`'s signature — temp-file + fsync +
 * rename), merging just the changed top-level key onto whatever
 * `readConfig()` currently returns. Neither key is hot-applied — every write
 * is restart-required, so both PUT handlers return `restartRequired: true`
 * unconditionally; GET reflects the config file as-is, so it always returns
 * `restartRequired: false`.
 *
 * See docs/superpowers/plans/2026-07-30-cutover-stage-1-solver-flow.md Task 17.
 */
import type { Hono } from 'hono';
import { z } from 'zod/v3';
import {
  ClaimPolicyConfigSchema,
  ExecutionWiringConfigEntrySchema,
} from '../config/shape-v2.js';
import type { JinnConfig } from '../config.js';

export interface ClaimPolicyRoutesConfig {
  readonly configPath: string;
  readonly readConfig: () => JinnConfig;
  readonly writeConfig: (filePath: string, value: unknown) => void;
}

const PutClaimPolicyBodySchema = z.object({ claimPolicy: ClaimPolicyConfigSchema });
const PutExecutionWiringBodySchema = z.object({
  executionWiring: z.array(ExecutionWiringConfigEntrySchema),
});

export function addClaimPolicyRoutes(app: Hono, config: ClaimPolicyRoutesConfig): void {
  app.get('/v1/operator/claim-policy', (c) => {
    const current = config.readConfig();
    return c.json({
      claimPolicy: current.claimPolicy,
      executionWiring: current.executionWiring ?? [],
      restartRequired: false,
    });
  });

  app.put('/v1/operator/claim-policy', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'expected JSON body' }, 400);
    }
    const parsed = PutClaimPolicyBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_claim_policy',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }
    const current = config.readConfig();
    config.writeConfig(config.configPath, { ...current, claimPolicy: parsed.data.claimPolicy });
    return c.json({ restartRequired: true });
  });

  app.put('/v1/operator/execution-wiring', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'expected JSON body' }, 400);
    }
    const parsed = PutExecutionWiringBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: 'invalid_execution_wiring',
          message: parsed.error.issues
            .map((i) => `${i.path.join('.') || '<body>'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    }
    const current = config.readConfig();
    config.writeConfig(config.configPath, {
      ...current,
      executionWiring: parsed.data.executionWiring,
    });
    return c.json({ restartRequired: true });
  });
}
