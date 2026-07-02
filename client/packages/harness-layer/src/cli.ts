/**
 * jinn-layer CLI — the human surface over the harness-layer consume path.
 *
 * Verbs (same command-module spirit as client/src/cli/commands/, kept
 * self-contained so the package stays embeddable):
 *
 *   jinn-layer corpus search "<query>" [--limit N] [--json]
 *   jinn-layer corpus get <ref> [--json] [--out <dir>]
 *   jinn-layer capture preview <task-file> [--json]
 *
 * Output is human-readable by default (this is a discovery surface);
 * --json emits the typed result as JSON (artifact content base64-encoded).
 * `capture preview` renders the scrub report: the redaction diff (original
 * values shown on the terminal only — they never leave the machine) and the
 * envelope exactly as it would publish. Its --json output strips the
 * original values so it stays persistence-safe.
 */

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createHarnessLayer,
  type CorpusRecord,
  type CorpusSearchHit,
  type HarnessLayer,
} from './consume.js';
import { capture, parseCapturedTask, type ScrubRedaction } from './capture.js';
import { preview, stripBeforeValues, type ScrubReport } from './preview.js';

const USAGE = `Usage: jinn-layer <command> [args]

Commands:
  corpus search "<query>" [--limit N] [--json]   Search corpus records (substring match on
                                                 solverType / role / artifactType / refs)
  corpus get <ref> [--json] [--out <dir>]        Fetch a record by ref (manifest CID from a
                                                 search result), including artifact content
  capture preview <task-file> [--json]           Scrub a captured task and show exactly what
                                                 would leave this machine: the redaction diff
                                                 plus the envelope as it would publish

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

/** Cap displayed before/after values so one huge attribute stays readable. */
const DIFF_VALUE_PREVIEW_CHARS = 400;

function renderDiffValue(value: unknown): string {
  if (value === undefined) return '(dropped — field is not published at all)';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = s.replace(/\n/g, '\\n');
  return flat.length > DIFF_VALUE_PREVIEW_CHARS
    ? `${flat.slice(0, DIFF_VALUE_PREVIEW_CHARS)}… (${flat.length} chars)`
    : flat;
}

/**
 * Group redaction entries by field: the pipeline reports one entry per
 * detection, so a busy attribute produces many entries with identical
 * before/after — one block per field with the union of firing stages is the
 * readable audit view.
 */
function renderRedactionsByField(redactions: ScrubRedaction[]): string[] {
  const byField = new Map<string, ScrubRedaction[]>();
  for (const r of redactions) {
    const group = byField.get(r.field) ?? [];
    group.push(r);
    byField.set(r.field, group);
  }
  const lines: string[] = [];
  for (const [field, group] of byField) {
    const stages = [...new Set(group.map((r) => `${r.stage}${r.detail ? ` (${r.detail})` : ''}`))];
    const first = group[0]!;
    const last = group[group.length - 1]!;
    lines.push(`  ${field}`);
    lines.push(`    stages   ${stages.join(', ')}`);
    if ('before' in first) lines.push(`    before   ${renderDiffValue(first.before)}`);
    lines.push(`    after    ${renderDiffValue(last.after)}`);
    lines.push('');
  }
  lines.pop(); // trailing blank
  return lines;
}

function renderScrubReport(report: ScrubReport): string {
  const truncated = report.envelope.steps.reduce(
    (n, s) => n + (s.truncatedKeys?.length ?? 0),
    0,
  );
  const lines = [
    'scrub preview — what would leave this machine',
    `  task     ${report.envelope.task.summary}`,
    `  steps    ${report.envelope.steps.length}`,
    `  scrub    ${report.redactions.length} redaction(s), ${truncated} truncation receipt(s)`,
    '',
  ];
  if (report.redactions.length === 0) {
    lines.push('no redactions — the scrub pipeline found nothing to remove');
  } else {
    lines.push(
      `${report.redactions.length} redaction(s) — "before" is shown here only and never leaves this machine`,
      '',
      ...renderRedactionsByField(report.redactions),
    );
  }
  lines.push(
    '',
    'envelope as it would publish:',
    JSON.stringify(report.envelope, null, 2),
  );
  return lines.join('\n');
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

  const isCorpus = verb === 'corpus' && (subverb === 'search' || subverb === 'get');
  const isCapturePreview = verb === 'capture' && subverb === 'preview';
  if (!isCorpus && !isCapturePreview) {
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

  if (isCapturePreview) {
    const taskFile = parsed.positionals[0];
    if (taskFile === undefined) {
      writer.write(`error: capture preview requires a <task-file> argument (a captured-task JSON file)\n\n${USAGE}`);
      return 2;
    }
    const task = parseCapturedTask(JSON.parse(readFileSync(taskFile, 'utf-8')));
    const report = preview(await capture(task));
    if (parsed.values.json) {
      // Persistence-safe projection: --json output may be piped to disk, so
      // the original (pre-scrub) values are stripped — they are for the
      // operator's eyes on their own terminal only.
      writer.write(JSON.stringify({
        envelope: report.envelope,
        redactions: stripBeforeValues(report.redactions),
      }) + '\n');
    } else {
      writer.write(renderScrubReport(report) + '\n');
    }
    return 0;
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
