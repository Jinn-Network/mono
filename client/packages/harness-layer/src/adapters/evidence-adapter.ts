/**
 * EvidencePort adapter (#1660) — a file-backed evidence store under one
 * captures dir that (AC2) round-trips a schema-canonical `EpisodeV1` AND reads
 * legacy `CapturedTask` captures, up-mapping them to `EpisodeV1`.
 *
 * Round-trip guarantee: `put` persists the schema-parsed form, so `get`
 * returns the canonical `EpisodeV1` for what was put — not necessarily the
 * caller's literal input. `EpisodeV1Schema` applies defaults
 * (`distributionTags`/`redactedKeys` → `[]`, `provenance` → `'contributed'`),
 * so a caller who omits defaulted fields reads back the canonicalized superset.
 *
 * Suffix discipline: written episodes are `<id>.episode.json`; legacy captures
 * are any other `*.json`. The two never collide — the strict `CapturedTaskSchema`
 * would reject the extra `EpisodeV1` fields, so `.episode.json` files are read
 * back only as episodes and legacy `.json` files only as captures.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type {
  EvidenceListQuery,
  EvidencePort,
  EvidenceRetentionPolicy,
  PortResult,
} from '@jinn-network/plugin';
import { EpisodeV1Schema, type EpisodeV1 } from '@jinn-network/plugin';
import { ok, unavailable } from '@jinn-network/plugin';
import { parseCapturedTask, type CapturedTask } from '../capture.js';

const DEFAULT_RETENTION: EvidenceRetentionPolicy = { policy: 'local-private', maxEpisodes: 200 };
const EPISODE_SUFFIX = '.episode.json';

export interface EvidenceAdapterDeps {
  /** The one dir this store reads legacy captures from AND writes episodes to. */
  capturesDir: string;
  /** Retention policy surfaced by `retention()` and used as the up-map default. */
  retention?: EvidenceRetentionPolicy;
}

/**
 * Up-map a legacy `CapturedTask` to a strict `EpisodeV1`. Fail-closed:
 * `EpisodeV1Schema.parse` throws if the up-map is wrong.
 *
 * Field gaps `CapturedTask` leaves that this fills: each step's discriminated
 * `kind`, `environment.skillsLoadout` (default `[]`), `retention.policy`
 * (from the adapter's configured retention), and `episodeId` (the sessionId).
 */
export function capturedTaskToEpisode(
  task: CapturedTask,
  retention: EvidenceRetentionPolicy,
): EpisodeV1 {
  const built = {
    schemaVersion: 'jinn.episode.v1' as const,
    episodeId: task.session.sessionId,
    session: task.session,
    task: {
      summary: task.task.summary,
      distributionTags: task.task.distributionTags,
    },
    trajectory: task.steps.map((step) => ({
      spanId: step.spanId,
      parentSpanId: step.parentSpanId,
      kind: stepKind(step),
      name: step.name,
      startTimeUnixNano: step.startTimeUnixNano,
      endTimeUnixNano: step.endTimeUnixNano,
      attributes: step.attributes,
      redactedKeys: step.redactedKeys,
    })),
    environment: {
      harness: task.environment.harness,
      model: task.environment.model,
      tools: task.environment.tools,
      skillsLoadout: [] as string[],
    },
    outcome: task.outcome,
    cost: task.cost,
    retention: { policy: retention.policy },
    provenance: task.provenance,
  };
  return EpisodeV1Schema.parse(built);
}

/**
 * Classify a legacy step as an agent turn or a tool call. Real `CapturedTask`
 * steps carry the capture-event convention — `jinn.capture.event.kind` is
 * user-message/assistant-message/tool-call/tool-result/edit, with `name`
 * falling back to `jinn.transcript.<kind>` — matching `distill-traces.ts`'s
 * `eventKind`. User/assistant messages are `jinn.agent_turn`; everything else
 * (tool calls/results, edits) is a `jinn.tool_call`.
 */
function stepKind(step: CapturedTask['steps'][number]): 'jinn.agent_turn' | 'jinn.tool_call' {
  const eventKind =
    typeof step.attributes['jinn.capture.event.kind'] === 'string'
      ? (step.attributes['jinn.capture.event.kind'] as string)
      : step.name;
  return /(^|\.)(user|assistant)-message$/.test(eventKind) ? 'jinn.agent_turn' : 'jinn.tool_call';
}

export function createEvidenceAdapter(deps: EvidenceAdapterDeps): EvidencePort {
  const capturesDir = deps.capturesDir;
  const retention = deps.retention ?? DEFAULT_RETENTION;

  function episodePath(id: string): string {
    // Defense-in-depth (#1660): `episodeId` is only `z.string().min(1)`, so it
    // permits `/`, `\`, and `..`. Reject any id that isn't a safe single path
    // segment, then belt-and-suspenders assert the resolved path stays inside
    // capturesDir — a crafted id must never escape the captures dir on write.
    if (id.includes('/') || id.includes('\\') || id.split(/[/\\]/).includes('..')) {
      throw new Error(`unsafe episodeId (path traversal): ${JSON.stringify(id)}`);
    }
    const path = join(capturesDir, `${id}${EPISODE_SUFFIX}`);
    const base = resolve(capturesDir);
    if (!resolve(path).startsWith(base + sep)) {
      throw new Error(`unsafe episodeId (escapes captures dir): ${JSON.stringify(id)}`);
    }
    return path;
  }

  return {
    async put(episode: EpisodeV1): Promise<PortResult<{ episodeId: string }>> {
      try {
        const parsed = EpisodeV1Schema.parse(episode);
        mkdirSync(capturesDir, { recursive: true });
        writeFileSync(episodePath(parsed.episodeId), JSON.stringify(parsed), 'utf-8');
        return ok({ episodeId: parsed.episodeId });
      } catch (e) {
        return unavailable(`evidence store put failed: ${String(e)}`);
      }
    },

    async get(episodeId: string): Promise<PortResult<EpisodeV1 | null>> {
      try {
        const path = episodePath(episodeId);
        if (!existsSync(path)) return ok(null);
        return ok(EpisodeV1Schema.parse(JSON.parse(readFileSync(path, 'utf-8'))));
      } catch (e) {
        return unavailable(`evidence store get failed: ${String(e)}`);
      }
    },

    async list(query: EvidenceListQuery = {}): Promise<PortResult<EpisodeV1[]>> {
      try {
        if (!existsSync(capturesDir)) return ok([]);
        const episodes: EpisodeV1[] = [];
        for (const file of readdirSync(capturesDir)) {
          const path = join(capturesDir, file);
          if (file.endsWith(EPISODE_SUFFIX)) {
            try {
              episodes.push(EpisodeV1Schema.parse(JSON.parse(readFileSync(path, 'utf-8'))));
            } catch (err) {
              console.warn(`[evidence] skipping malformed episode file ${file}: ${String(err)}`);
            }
          } else if (file.endsWith('.json')) {
            // A legacy CapturedTask capture — up-map it. A capture that fails
            // to parse or up-map is skipped (warn), never throws.
            try {
              const task = parseCapturedTask(JSON.parse(readFileSync(path, 'utf-8')));
              episodes.push(capturedTaskToEpisode(task, retention));
            } catch (err) {
              console.warn(`[evidence] skipping malformed legacy capture ${file}: ${String(err)}`);
            }
          }
        }
        return ok(query.limit ? episodes.slice(0, query.limit) : episodes);
      } catch (e) {
        return unavailable(`evidence store list failed: ${String(e)}`);
      }
    },

    async retention(): Promise<PortResult<EvidenceRetentionPolicy>> {
      return ok(retention);
    },
  };
}
