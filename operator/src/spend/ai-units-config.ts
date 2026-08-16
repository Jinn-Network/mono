/**
 * Daemon-side AI-units gate config — issue #815.
 *
 * Resolves, per-manifest:
 *   - the credential that manifest's harness bills against
 *   - the projected AI-unit cost of one task on that harness/model
 *
 * Plus the active per-block / per-week caps from
 * `resolveReferenceCeiling(env)`.
 *
 * Returns undefined only when no joined SolverNet resolves to a
 * credential the gate could meaningfully meter — at that point the
 * gate stays off entirely so the daemon does not spend a query per
 * task on rows that will never sum.
 */
import type { JinnConfig } from '../config.js';
import { wiringParticipationKey } from '../config/participation.js';
import { resolveCredentialId, type CredentialId } from './credential.js';
import {
  projectAiUnits,
  projectTaskUsdMicros,
  resolveReferenceCeiling,
  resolveReferenceCeilingUsdMicros,
} from './ai-units.js';

export interface AiUnitsDaemonConfig {
  /** Unit caps — retained for the legacy /v1/status unit surface (#1006). */
  capPerBlock: number;
  capPerWeek: number;
  /** USD-micros caps — what the gate now compares against (issue #1004). */
  capPerBlockUsdMicros: number;
  capPerWeekUsdMicros: number;
  /** manifestCid -> credentialId (set only when the harness has one). */
  manifestCredentials: Record<string, CredentialId>;
  /**
   * manifestCid -> projected AI units per task. `null` means the model
   * is unknown to the cost table and the gate must fail-open with a
   * one-time warn rather than silently halting claims.
   */
  manifestProjectedAiUnits: Record<string, number | null>;
  /**
   * manifestCid -> projected USD micros per task (issue #1004). `null` =
   * unpriceable model (gate fails open with a warn), same semantics as
   * {@link manifestProjectedAiUnits}.
   */
  manifestProjectedUsdMicros: Record<string, number | null>;
  /**
   * manifestCid -> the model id from the joined SolverNet config. Threaded
   * onto the per-request activity row at claim time so the row carries
   * provenance of the projection. May be undefined when the operator
   * joined without selecting a model.
   */
  manifestModels: Record<string, string | undefined>;
}

export function buildAiUnitsConfig(
  config: Pick<JinnConfig, 'executionWiring'>,
  env: NodeJS.ProcessEnv,
  /** Optional home dir override for resolveCredentialId's disk probe — tests only. */
  homeDirOverride?: string,
): AiUnitsDaemonConfig | undefined {
  const { units_per_block, units_per_week } = resolveReferenceCeiling(env);
  const { usd_micros_per_block, usd_micros_per_week } = resolveReferenceCeilingUsdMicros(env);

  const manifestCredentials: Record<string, CredentialId> = {};
  const manifestProjectedAiUnits: Record<string, number | null> = {};
  const manifestProjectedUsdMicros: Record<string, number | null> = {};
  const manifestModels: Record<string, string | undefined> = {};

  for (const entry of config.executionWiring ?? []) {
    const credentialId = resolveCredentialId(entry.harness, env, homeDirOverride);
    if (!credentialId) continue;
    const key = wiringParticipationKey(entry);
    manifestCredentials[key] = credentialId;
    manifestProjectedAiUnits[key] = projectAiUnits(entry.harness, entry.model, credentialId);
    manifestProjectedUsdMicros[key] = projectTaskUsdMicros(entry.harness, entry.model, credentialId);
    manifestModels[key] = entry.model;
  }

  if (Object.keys(manifestCredentials).length === 0) return undefined;

  return {
    capPerBlock: units_per_block,
    capPerWeek: units_per_week,
    capPerBlockUsdMicros: usd_micros_per_block,
    capPerWeekUsdMicros: usd_micros_per_week,
    manifestCredentials,
    manifestProjectedAiUnits,
    manifestProjectedUsdMicros,
    manifestModels,
  };
}
