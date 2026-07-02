/**
 * jinn-layer CLI — the human surface over the harness-layer consume path.
 *
 * Verbs (same command-module spirit as client/src/cli/commands/, kept
 * self-contained so the package stays embeddable):
 *
 *   jinn-layer corpus search "<query>" [--limit N] [--json]
 *   jinn-layer corpus get <ref> [--json] [--out <dir>]
 *
 * Output is human-readable by default (this is a discovery surface);
 * --json emits the typed result as JSON (artifact content base64-encoded).
 */

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarnessLayer,
  type CorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
} from './consume.js';

const USAGE = `Usage: jinn-layer <command> [args]

Commands:
  corpus search "<query>" [--limit N] [--json]   Search corpus records (substring match on
                                                 solverType / role / artifactType / refs)
  corpus get <ref> [--json] [--out <dir>]        Fetch a record by ref (manifest CID from a
                                                 search result), including artifact content

Environment:
  JINN_DISCOVERY_URL       Override the discovery indexer URL (default: testnet Ponder indexer)
  JINN_IPFS_GATEWAY_URL    Override the IPFS gateway (default: https://gateway.autonolas.tech)
`;

export interface RunJinnLayerCliOptions {
  /** Injectable layer (tests). Default: createHarnessLayer() with env overrides. */
  layer?: HarnessLayer;
  writer?: { write: (s: string) => boolean };
}

const DEFAULT_CLI_SEARCH_LIMIT = 20;

/**
 * Render an envelope `generatedAt` as ISO. Producers are inconsistent about
 * unit — most stamp unix seconds, some stamp milliseconds — so use the usual
 * magnitude heuristic (>= 1e12 means it cannot be seconds until year 33658).
 */
function generatedAtIso(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const ms = value >= 1e12 ? value : value * 1000;
  return new Date(ms).toISOString();
}

function renderHit(hit: CorpusSearchHit): string {
  const lines = [
    hit.title,
    `  ref            ${hit.ref}`,
    `  operator       agentId=${hit.operator.agentId || '-'} safe=${hit.operator.safeAddress || '-'}`,
    `  evidence tier  ${hit.evidenceTier}`,
    `  generated at   ${generatedAtIso(hit.generatedAt)}`,
    // publishedAt is backing-dependent (block number on the HTTP indexer,
    // unix time elsewhere) — print raw, never as a date.
    `  published      ${hit.publishedAt}`,
    `  task           ${hit.task ? hit.task.cid : '-'}`,
    `  artifacts      ${hit.artifactTypes.join(', ') || '-'}`,
  ];
  return lines.join('\n');
}

const CONTENT_PREVIEW_BYTES = 2000;

function renderRecord(record: CorpusRecord, outDir?: string): string {
  const lines = [
    `${record.envelope.solverType} / ${record.envelope.role}`,
    `  ref            ${record.ref}`,
    `  operator       agentId=${record.provenance.operator.agentId || '-'} safe=${record.provenance.operator.safeAddress || '-'}`,
    `  evidence tier  ${record.provenance.evidenceTier}`,
    `  published      ${record.provenance.publishedAt}`,
    '',
    `${record.artifacts.length} artifact(s)`,
  ];
  for (const a of record.artifacts) {
    lines.push(
      '',
      `artifact ${a.sha256}`,
      `  type    ${a.artifactType}`,
      `  size    ${a.sizeBytes} bytes`,
      `  source  ${a.source}`,
    );
    if (outDir) {
      const path = join(outDir, a.sha256);
      writeFileSync(path, a.content);
      lines.push(`  saved   ${path}`);
    } else {
      const preview = a.content.subarray(0, CONTENT_PREVIEW_BYTES).toString('utf-8');
      const truncated = a.sizeBytes > CONTENT_PREVIEW_BYTES ? `\n  … truncated (${a.sizeBytes} bytes total; use --out <dir> for full content)` : '';
      lines.push(`  content:\n${preview}${truncated}`);
    }
  }
  return lines.join('\n');
}

function recordToJson(record: CorpusRecord): unknown {
  return {
    ...record,
    artifacts: record.artifacts.map((a) => ({
      sha256: a.sha256,
      artifactType: a.artifactType,
      source: a.source,
      sizeBytes: a.sizeBytes,
      contentBase64: a.content.toString('base64'),
    })),
  };
}

function buildDefaultLayer(): HarnessLayer {
  return createHarnessLayer({
    ...(process.env['JINN_DISCOVERY_URL'] ? { discoveryUrl: process.env['JINN_DISCOVERY_URL'] } : {}),
    ...(process.env['JINN_IPFS_GATEWAY_URL'] ? { ipfsGatewayUrl: process.env['JINN_IPFS_GATEWAY_URL'] } : {}),
  });
}

/** Returns the process exit code (0 = success). */
export async function runJinnLayerCli(
  argv: string[],
  opts: RunJinnLayerCliOptions = {},
): Promise<number> {
  const writer = opts.writer ?? process.stdout;
  const [verb, subverb, ...rest] = argv;

  if (verb !== 'corpus' || (subverb !== 'search' && subverb !== 'get')) {
    writer.write(USAGE);
    return verb === undefined || verb === 'help' || verb === '--help' ? 0 : 2;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: {
        limit: { type: 'string', default: String(DEFAULT_CLI_SEARCH_LIMIT) },
        json: { type: 'boolean', default: false },
        out: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    writer.write(`error: ${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 2;
  }

  const layer = opts.layer ?? buildDefaultLayer();

  if (subverb === 'search') {
    const query = parsed.positionals[0];
    if (query === undefined) {
      writer.write(`error: corpus search requires a <query> argument (use "" for all records)\n\n${USAGE}`);
      return 2;
    }
    const n = Number.parseInt(parsed.values.limit as string, 10);
    const limit = Math.min(Math.max(Number.isFinite(n) ? n : DEFAULT_CLI_SEARCH_LIMIT, 1), 500);
    const hits = await layer.corpus.search(query, { limit });
    if (parsed.values.json) {
      writer.write(JSON.stringify(hits) + '\n');
    } else if (hits.length === 0) {
      writer.write('No corpus records matched.\n');
    } else {
      writer.write(`${hits.length} result(s)\n\n${hits.map(renderHit).join('\n\n')}\n`);
    }
    return 0;
  }

  // corpus get
  const ref = parsed.positionals[0];
  if (ref === undefined) {
    writer.write(`error: corpus get requires a <ref> argument (a manifest CID from a search result)\n\n${USAGE}`);
    return 2;
  }
  const outDir = parsed.values.out as string | undefined;
  if (outDir) mkdirSync(outDir, { recursive: true });
  const record = await layer.corpus.get(ref);
  if (parsed.values.json) {
    writer.write(JSON.stringify(recordToJson(record)) + '\n');
  } else {
    writer.write(renderRecord(record, outDir) + '\n');
  }
  return 0;
}
