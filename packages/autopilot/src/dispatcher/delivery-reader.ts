import { BridgeEnvelopeSchema, MARKETPLACE_SOLVER_TYPE } from './delivery-pr-bridge.js';
import type { BridgeEnvelope, DeliveredRecord, DeliveryReader } from './delivery-pr-bridge.js';

/**
 * Production `DeliveryReader`: GraphQL POST to the indexer for envelope rows
 * + plain HTTP GET against the IPFS gateway for envelope/task documents.
 *
 * NARROW by design (coordinator override, issue #1892): replicates the
 * minimal GraphQL query shape from `client/src/discovery/http.ts`'s
 * `QUERY_ENVELOPES_QUERY` and the plain-fetch pattern from
 * `client/src/corpus/fetch.ts` — does not import either (autopilot must not
 * depend on `@jinn-network/client`). Also does not replicate
 * `client/src/adapters/mech/ipfs.ts`'s multi-codec/multi-gateway fallback
 * machinery; a single gateway GET is enough for this reader's job.
 *
 * The indexer's `envelopes` query has no `solverType` filter (solverType
 * lives in the IPFS envelope body, not an indexed column — see
 * `client/src/discovery/http.ts`'s note on `queryEnvelopes`), so this reader
 * fetches a page of the most recent envelope rows and filters client-side
 * after resolving each body from IPFS.
 *
 * Cursor: `generatedAt` (from the envelope body, not the indexer's
 * `publishedAtBlock`) is cached on the instance and advanced past every
 * envelope body successfully resolved this call, regardless of whether it
 * matched `MARKETPLACE_SOLVER_TYPE` — losing it on restart (in-memory only,
 * no persistence) just widens the next scan, it never causes a miss.
 */

type FetchFn = typeof fetch;

interface EnvelopeIndexRow {
  manifestCid: string;
}

interface EnvelopesGqlResponse {
  data?: { envelopes?: { items?: EnvelopeIndexRow[] } };
  errors?: Array<{ message?: string }>;
}

/** Mirrors the minimal shape of `QUERY_ENVELOPES_QUERY` in `client/src/discovery/http.ts`. */
const ENVELOPES_QUERY = `
query RecentEnvelopes($limit: Int!) {
  envelopes(
    limit: $limit,
    orderBy: "publishedAtBlock",
    orderDirection: "desc"
  ) {
    items {
      manifestCid
    }
  }
}
`;

export interface HttpDeliveryReaderOpts {
  /** Indexer base URL or full `/graphql` endpoint. */
  indexerUrl: string;
  ipfsGatewayUrl: string;
  /** Most-recent-envelopes page size per poll. Default 200. */
  limit?: number;
  /** Injectable for tests — never real network in a test process. */
  fetchImpl?: FetchFn;
}

export class HttpDeliveryReader implements DeliveryReader {
  private cursor = 0;
  private readonly gqlUrl: string;
  private readonly ipfsBase: string;
  private readonly limit: number;
  private readonly fetchImpl: FetchFn;

  constructor(opts: HttpDeliveryReaderOpts) {
    this.gqlUrl = opts.indexerUrl.endsWith('/graphql')
      ? opts.indexerUrl
      : `${opts.indexerUrl.replace(/\/$/, '')}/graphql`;
    this.ipfsBase = opts.ipfsGatewayUrl.replace(/\/$/, '');
    this.limit = opts.limit ?? 200;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async pollSolutions(): Promise<DeliveredRecord[]> {
    const rows = await this.fetchEnvelopeRows();
    const out: DeliveredRecord[] = [];
    let maxSeen = this.cursor;

    for (const row of rows) {
      let raw: unknown;
      try {
        raw = await this.fetchIpfsJson(row.manifestCid);
      } catch (err) {
        console.error(`[delivery-reader] envelope fetch failed for ${row.manifestCid} (skipping):`, err);
        continue;
      }

      const parsed = BridgeEnvelopeSchema.safeParse(raw);
      if (!parsed.success) continue; // not a jinn.execution.v1 envelope — not ours to bridge
      const envelope: BridgeEnvelope = parsed.data;

      if (envelope.generatedAt > maxSeen) maxSeen = envelope.generatedAt;
      if (envelope.generatedAt <= this.cursor) continue; // already scanned in a prior poll
      if (envelope.solverType !== MARKETPLACE_SOLVER_TYPE) continue;

      let taskRaw: unknown;
      try {
        taskRaw = await this.fetchIpfsJson(envelope.task.cid);
      } catch (err) {
        console.error(
          `[delivery-reader] task doc fetch failed for ${envelope.task.cid} (skipping envelope ${row.manifestCid}):`,
          err,
        );
        continue;
      }

      out.push({ manifestCid: row.manifestCid, envelope, taskRaw });
    }

    this.cursor = maxSeen;
    return out;
  }

  private async fetchEnvelopeRows(): Promise<EnvelopeIndexRow[]> {
    const res = await this.fetchImpl(this.gqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: ENVELOPES_QUERY, variables: { limit: this.limit } }),
    });
    if (!res.ok) {
      throw new Error(`[delivery-reader] indexer query failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as EnvelopesGqlResponse;
    if (json.errors != null && json.errors.length > 0) {
      throw new Error(`[delivery-reader] indexer query errors: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    return json.data?.envelopes?.items ?? [];
  }

  private async fetchIpfsJson(cid: string): Promise<unknown> {
    const res = await this.fetchImpl(`${this.ipfsBase}/ipfs/${cid}`);
    if (!res.ok) {
      throw new Error(`[delivery-reader] IPFS gateway fetch failed for ${cid}: HTTP ${res.status}`);
    }
    return res.json();
  }
}
