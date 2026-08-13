import { JinnRepoApplicationVerdictPayloadSchema } from '@jinn-network/sdk/solvernets/jinn-repo';
import { VerdictCode, type VerdictCode as VerdictCodeValue } from '../adapters/mech/verdict-code.js';

/** Maps only the generic application settlement projection to the chain enum. */
export function applicationVerdictProjectionCode(
  payload: unknown,
): VerdictCodeValue | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (
    record['schemaVersion'] !== 'jinn-repo-application-payload.v1'
    || record['role'] !== 'verdict'
  ) return undefined;
  const parsed = JinnRepoApplicationVerdictPayloadSchema.parse(payload);
  if (parsed.projection === 'pass') return VerdictCode.Pass;
  if (parsed.projection === 'fail') return VerdictCode.Fail;
  return VerdictCode.Unresolved;
}
