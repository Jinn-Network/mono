/**
 * ContributionPort adapter (#1660) — projects the plugin's 4-state
 * (`queued|minted|published|vetoed`) contribution ledger over an adapter-owned
 * JSON status store.
 *
 * BINDING (#1660 plan): backed SOLELY by the adapter-owned
 * `ContributionStatusStore`. It does NOT import `MineableTraceStore` or
 * anything from `client/src/**` — that would create a backwards
 * `harness-layer → client/src` dependency the Stage-1 package split exists to
 * prevent. `minted`/`published` are forward states an off-adapter mint/publish
 * path sets; the adapter only authors `queued` and `vetoed`.
 */
import type {
  ContributionLedgerEntry,
  ContributionPort,
  PortResult,
} from '@jinn-network/plugin';
import { ok, unavailable } from '@jinn-network/plugin';
import { readJsonMap, writeJsonMap } from './json-map-store.js';

export type ContributionStatus = ContributionLedgerEntry['status'];

export interface ContributionStatusEntry {
  recordId: string;
  episodeId: string;
  status: ContributionStatus;
}

/**
 * A tiny file-backed JSON status store: `{ recordId → { episodeId, status } }`,
 * over the shared atomic JSON-map primitive. Missing file ⇒ empty.
 */
export interface ContributionStatusStore {
  get(recordId: string): ContributionStatusEntry | undefined;
  list(): ContributionStatusEntry[];
  put(entry: ContributionStatusEntry): void;
  setStatus(recordId: string, status: ContributionStatus): void;
}

type StatusValue = Omit<ContributionStatusEntry, 'recordId'>;

export function createContributionStatusStore(path: string): ContributionStatusStore {
  return {
    get(recordId) {
      const entry = readJsonMap<StatusValue>(path)[recordId];
      return entry ? { recordId, ...entry } : undefined;
    },
    list() {
      const map = readJsonMap<StatusValue>(path);
      return Object.entries(map).map(([recordId, entry]) => ({ recordId, ...entry }));
    },
    put(entry) {
      const map = readJsonMap<StatusValue>(path);
      map[entry.recordId] = { episodeId: entry.episodeId, status: entry.status };
      writeJsonMap(path, map);
    },
    setStatus(recordId, status) {
      const map = readJsonMap<StatusValue>(path);
      const existing = map[recordId];
      if (!existing) return;
      map[recordId] = { ...existing, status };
      writeJsonMap(path, map);
    },
  };
}

export interface ContributionAdapterDeps {
  statusStore: ContributionStatusStore;
}

export function createContributionAdapter(deps: ContributionAdapterDeps): ContributionPort {
  const { statusStore } = deps;
  let recordCounter = 0;

  return {
    async recordMineable(episodeId: string): Promise<PortResult<{ recordId: string }>> {
      try {
        recordCounter += 1;
        const recordId = `record-${Date.now()}-${recordCounter}`;
        statusStore.put({ recordId, episodeId, status: 'queued' });
        return ok({ recordId });
      } catch (e) {
        return unavailable(`contribution store recordMineable failed: ${String(e)}`);
      }
    },

    async ledger(): Promise<PortResult<ContributionLedgerEntry[]>> {
      try {
        const entries: ContributionLedgerEntry[] = statusStore
          .list()
          .map((r) => ({ recordId: r.recordId, episodeId: r.episodeId, status: r.status }));
        return ok(entries);
      } catch (e) {
        return unavailable(`contribution ledger failed: ${String(e)}`);
      }
    },

    async mintStatus(recordId: string): Promise<PortResult<{ status: ContributionStatus }>> {
      const record = statusStore.get(recordId);
      if (!record) return unavailable(`no such record: ${recordId}`);
      return ok({ status: record.status });
    },

    async veto(recordId: string): Promise<PortResult<{ recordId: string; status: 'vetoed' }>> {
      const record = statusStore.get(recordId);
      if (!record) return unavailable(`no such record: ${recordId}`);
      try {
        statusStore.setStatus(recordId, 'vetoed');
        return ok({ recordId, status: 'vetoed' as const });
      } catch (e) {
        return unavailable(`contribution veto failed: ${String(e)}`);
      }
    },
  };
}
