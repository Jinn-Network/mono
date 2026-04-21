/**
 * Shared helpers for the `jinn intents` CLI surface.
 *
 * - Builds a RestorerImplRegistry populated with the same impls the daemon
 *   registers at boot (minus the ones that need live dependencies like a
 *   running master wallet). The generic `intents list/status/enable/disable`
 *   verbs use this to dispatch to per-impl onEnable / isReady logic without
 *   standing up the full daemon.
 *
 * - Reads/writes the `restorers.disabled[]` list in the operator's config
 *   file so `enable` / `disable` can flip per-impl participation.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { RestorerImplRegistry } from '../restorer/engine/registry.js';
import { PredictionV0BaselineImpl } from '../restorer/impls/prediction-v0-baseline/index.js';
import { PredictionV0Evaluator } from '../restorer/impls/prediction-v0-evaluator/index.js';
import { ClaudeMcpHyperliquidImpl } from '../restorer/impls/claude-mcp-hyperliquid/index.js';
import { PortfolioV0Evaluator } from '../restorer/impls/portfolio-v0-evaluator/index.js';
import type { JinnConfig } from '../config.js';

/**
 * Impls that ship default-disabled because they require external dependencies
 * (credentials, exchange approvals, etc.) the operator must opt into. Kept in
 * one place so `main.ts` and the `intents` CLI share a single source of truth.
 */
export const DEFAULT_DISABLED_IMPLS = ['claude-mcp-hyperliquid'] as const;

const DEFAULT_CONFIG_PATH = join(homedir(), '.jinn-client', 'config.json');

export function resolveConfigPath(explicit?: string): string {
  return explicit ?? DEFAULT_CONFIG_PATH;
}

/**
 * Construct the same impl registry main.ts uses, populated with the subset
 * of impls that can answer `isReady` / `onEnable` without live chain/runner
 * dependencies. Evaluators and the legacy-claude impl are omitted because
 * they don't expose enable-level UX (legacy-claude is always-on; evaluators
 * dispatch by type='evaluation' rather than by kind).
 */
export function buildIntentsCliRegistry(config: JinnConfig): RestorerImplRegistry {
  const registry = new RestorerImplRegistry({
    byKind: {
      'portfolio.v0': 'claude-mcp-hyperliquid',
      'prediction.v0': 'prediction-v0-baseline',
    },
    default: 'legacy-claude',
    disabled: resolveEffectiveDisabled(config),
  });

  registry.register(new PredictionV0BaselineImpl({ rpcUrl: config.rpcUrl }));
  registry.register(new PredictionV0Evaluator({
    evaluatorPk: '0x' + '00'.repeat(32) as `0x${string}`,
    evaluatorSafeAddress: '0x0000000000000000000000000000000000000000',
    rpcUrl: config.rpcUrl,
  }));
  registry.register(new ClaudeMcpHyperliquidImpl({
    claudePath: config.claudePath,
    claudeModel: config.claudeModel,
  }));
  registry.register(new PortfolioV0Evaluator());

  return registry;
}

/**
 * Resolve the effective disabled list, applying the ship-default plus any
 * operator overrides. Semantics match main.ts: user config fully replaces
 * the default, so operators who have already curated a list aren't
 * surprised by new defaults sneaking in.
 */
export function resolveEffectiveDisabled(config: JinnConfig): string[] {
  const userDisabled = config.restorers?.disabled;
  if (userDisabled !== undefined) return [...userDisabled];
  return [...DEFAULT_DISABLED_IMPLS];
}

/** Is an impl currently disabled in the effective config? */
export function isImplDisabled(implName: string, config: JinnConfig): boolean {
  return resolveEffectiveDisabled(config).includes(implName);
}

interface RestorersPatch {
  byKind?: Record<string, string>;
  default?: string;
  disabled?: string[];
}

/**
 * Patch the user's config file to add/remove an impl from the `restorers.disabled[]`
 * list.
 *
 * Semantics (important): since user config fully replaces the default list,
 * we always rebuild `disabled` from `DEFAULT_DISABLED_IMPLS ∪ user additions`
 * minus the currently-enabled impl, not from whatever list the user last
 * wrote. Concretely: if we later add a new default-disabled impl, an operator
 * who previously enabled X won't silently auto-enable the new one — their
 * written list always reflects "every current default off, minus what I've
 * explicitly enabled." Extra operator-added disables are preserved verbatim.
 *
 * Returns the new disabled list for the caller to surface.
 */
export function setImplEnabledInConfig(
  implName: string,
  enabled: boolean,
  configPath: string = DEFAULT_CONFIG_PATH,
): string[] {
  let current: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      current = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
  }

  const restorers = (current['restorers'] ?? {}) as RestorersPatch;
  const existing = new Set(restorers.disabled ?? []);
  // Operator-added extras: anything they've explicitly disabled that isn't a ship default.
  const defaults = new Set(DEFAULT_DISABLED_IMPLS as readonly string[]);
  const operatorExtras = new Set(
    [...existing].filter((n) => !defaults.has(n)),
  );

  // Rebuild from first principles so future default additions stay disabled
  // unless the operator explicitly enables them too.
  const rebuilt = new Set<string>([...defaults, ...operatorExtras]);

  if (enabled) {
    rebuilt.delete(implName);
  } else {
    rebuilt.add(implName);
  }

  const next = [...rebuilt];
  restorers.disabled = next;
  current['restorers'] = restorers;

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(current, null, 2) + '\n', { encoding: 'utf-8' });

  return next;
}
