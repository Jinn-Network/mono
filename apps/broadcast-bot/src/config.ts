import { readFileSync, existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

export const BroadcastConfigSchema = z.object({
  github: z.object({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, 'expected "owner/name"'),
    sources: z.array(z.enum(['releases', 'prs', 'discussions'])).default([]),
    prs: z
      .object({
        baseBranches: z.array(z.string()).default(['next', 'main']),
        excludeAuthors: z.array(z.string()).default([
          'dependabot[bot]',
          'github-actions[bot]',
        ]),
        excludePrefixes: z.array(z.string()).default(['chore(deps)']),
      })
      .default({}),
    discussions: z
      .object({
        categories: z.array(z.string()).default(['Announcements', 'RFCs']),
      })
      .default({}),
  }),
  onchain: z
    .object({
      enabled: z.boolean().default(false),
      rpcUrl: z.string().url().optional(),
      chainId: z.number().int().positive().optional(),
      sources: z
        .array(z.enum(['solvernet-manifests', 'plugins']))
        .default(['solvernet-manifests', 'plugins']),
      contracts: z
        .object({
          identityRegistry: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
        })
        .default({}),
      /** Cap on blocks-per-getLogs window to stay under public RPC limits. */
      blockChunk: z.number().int().positive().default(2000),
    })
    .default({}),
  composer: z
    .object({
      model: z.string().default('claude-sonnet-4-6'),
      maxChars: z.number().int().positive().default(240),
      claudePath: z.string().default('claude'),
      /** Per-call wall-clock timeout for the `claude -p` subprocess. */
      timeoutMs: z.number().int().positive().default(60_000),
    })
    .default({}),
  poster: z
    .object({
      backend: z.enum(['x', 'stdout']).default('x'),
      /** Skip posting when true — useful for cron canary runs. */
      dryRun: z.boolean().default(false),
    })
    .default({}),
});

export type BroadcastConfig = z.infer<typeof BroadcastConfigSchema>;

/** Load config from a TOML file, then apply env overrides for secrets-only knobs. */
export function loadConfig(path: string): BroadcastConfig {
  if (!existsSync(path)) {
    throw new Error(`config file not found: ${path}`);
  }
  const raw = parseToml(readFileSync(path, 'utf-8'));
  const parsed = BroadcastConfigSchema.parse(deepCamel(raw));
  // RPC URL can override via env so secrets don't land in the config file.
  if (process.env['JINN_RPC_URL']) {
    parsed.onchain.rpcUrl = process.env['JINN_RPC_URL'];
  }
  return parsed;
}

/**
 * TOML files use snake_case by convention; Zod schema uses camelCase. Cheap
 * recursive rekey — only handles plain objects and arrays, which is all we
 * accept from TOML.
 */
function deepCamel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepCamel);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[camel] = deepCamel(v);
    }
    return out;
  }
  return value;
}
