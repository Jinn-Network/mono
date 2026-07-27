import type {
  CorpusPort,
  CorpusRecord,
  KnowledgeHit,
  PortResult,
} from '@jinn-network/plugin';
import {
  degraded,
  ok,
  unavailable,
  valueOr,
} from '@jinn-network/plugin';
import { LOCAL_EPISODE_REF_PREFIX } from './local-episode-corpus-adapter.js';

type ChildName = 'local' | 'public';

export interface FederatedCorpusAdapterDeps {
  local: CorpusPort;
  public: CorpusPort;
  timeoutMs?: number;
}

// Cold public corpus reads can take longer than five seconds while still
// completing inside Hermes' 15-second session-pickup deadline.
export const DEFAULT_FEDERATED_CHILD_TIMEOUT_MS = 10_000;

export function createFederatedCorpusAdapter(
  deps: FederatedCorpusAdapterDeps,
): CorpusPort {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_FEDERATED_CHILD_TIMEOUT_MS;
  const openCircuit = new Set<ChildName>();

  async function call<T>(
    child: ChildName,
    operation: () => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    if (openCircuit.has(child)) {
      return unavailable(`${child} corpus circuit open after timeout`);
    }

    let operationResult: Promise<PortResult<T>>;
    try {
      operationResult = Promise.resolve(operation());
    } catch (error) {
      return unavailable(`${child} corpus rejected: ${String(error)}`);
    }
    const handledOperation = operationResult.catch((error) =>
      unavailable<T>(`${child} corpus rejected: ${String(error)}`),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        handledOperation,
        new Promise<PortResult<T>>((resolve) => {
          timer = setTimeout(() => {
            openCircuit.add(child);
            resolve(unavailable(`${child} corpus timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      return unavailable(`${child} corpus rejected: ${String(error)}`);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function reasonFor(
    child: ChildName,
    result: PortResult<unknown>,
  ): string | undefined {
    return result.status === 'ok' ? undefined : `${child} corpus: ${result.reason}`;
  }

  async function search(query: string): Promise<PortResult<KnowledgeHit[]>> {
    const [localResult, publicResult] = await Promise.all([
      call('local', () => deps.local.search(query)),
      call('public', () => deps.public.search(query)),
    ]);
    const seen = new Set<string>();
    const hits = [
      ...valueOr(localResult, []),
      ...valueOr(publicResult, []),
    ].filter((hit) => {
      if (seen.has(hit.ref)) return false;
      seen.add(hit.ref);
      return true;
    });

    if (
      localResult.status === 'unavailable'
      && publicResult.status === 'unavailable'
    ) {
      return unavailable([
        reasonFor('local', localResult),
        reasonFor('public', publicResult),
      ].filter(Boolean).join('; '));
    }

    const reason = [
      reasonFor('local', localResult),
      reasonFor('public', publicResult),
    ].find((value) => value !== undefined);
    return reason === undefined ? ok(hits) : degraded(reason, hits);
  }

  async function get(ref: string): Promise<PortResult<CorpusRecord | null>> {
    const child: ChildName = ref.startsWith(LOCAL_EPISODE_REF_PREFIX)
      ? 'local'
      : 'public';
    return call(child, () => deps[child].get(ref));
  }

  return { search, get };
}
