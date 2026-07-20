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
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import {
  link,
  lstat,
  open,
  rm,
} from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  EvidenceListQuery,
  EvidencePort,
  EvidenceRetentionPolicy,
  PortResult,
} from '@jinn-network/plugin';
import { EpisodeV1Schema, EpisodeV1WriteSchema, type EpisodeV1 } from '@jinn-network/plugin';
import { degraded, ok, unavailable } from '@jinn-network/plugin';
import { parseCapturedTask, type CapturedTask } from './captured-task.js';
import {
  assertSafeOwner,
  fsyncDirectory,
  identityFrom,
  inspectRegularPath,
  nodeErrorCode,
  openVerifiedRegular,
  prepareEvidenceDirectory,
  readVerifiedText,
  sameIdentity,
  secureRegularPath,
  validateDirectory,
  type FileIdentity,
} from './evidence-filesystem.js';
import { withEvidenceStoreLock } from './evidence-store-lock.js';

const DEFAULT_RETENTION: EvidenceRetentionPolicy = { policy: 'local-private', maxEpisodes: 200 };
const EPISODE_SUFFIX = '.episode.json';
const MAX_PORTABLE_FILENAME_BYTES = 255;
const HASHED_EPISODE_STEM = /^episode-[a-f0-9]{64}$/;

export function episodeFileName(id: string): string {
  const literalStemIsSafe = /^[A-Za-z0-9._-]+$/.test(id)
    && id !== '.'
    && id !== '..'
    && !HASHED_EPISODE_STEM.test(id)
    && Buffer.byteLength(`${id}${EPISODE_SUFFIX}`, 'utf8') <= MAX_PORTABLE_FILENAME_BYTES;
  const stem = literalStemIsSafe
    ? id
    : `episode-${createHash('sha256').update(id).digest('hex')}`;
  return `${stem}${EPISODE_SUFFIX}`;
}

export interface EvidenceAdapterDeps {
  /** The one dir this store reads legacy captures from AND writes episodes to. */
  capturesDir: string;
  /** Retention policy surfaced by `retention()` and used as the up-map default. */
  retention?: EvidenceRetentionPolicy;
  /**
   * Best-effort notification after a successful write and retention pass.
   * Derived views may refresh here, but their failure never invalidates the
   * canonical episode write.
   */
  onStoreChanged?: () => void | Promise<void>;
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
    task: task.task,
    trajectory: task.steps.map((step) => ({
      spanId: step.spanId,
      parentSpanId: step.parentSpanId,
      kind: step.kind ?? stepKind(step),
      name: step.name,
      startTimeUnixNano: step.startTimeUnixNano,
      endTimeUnixNano: step.endTimeUnixNano,
      attributes: step.attributes,
      redactedKeys: step.redactedKeys,
    })),
    environment: {
      ...task.environment,
      skillsLoadout: task.environment.skillsLoadout ?? [],
    },
    outcome: task.outcome,
    cost: task.cost,
    retention: { policy: retention.policy },
    provenance: task.provenance,
    ...(task.attemptGroup ? { attemptGroup: task.attemptGroup } : {}),
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
    // EpisodeV1 intentionally permits opaque host ids. Safe ids retain the
    // original filename; path-shaped or platform-unsafe ids use a stable hash
    // that the Python fallback mirrors exactly.
    const path = join(capturesDir, episodeFileName(id));
    const base = resolve(capturesDir);
    if (!resolve(path).startsWith(base + sep)) {
      throw new Error(`unsafe episodeId (escapes captures dir): ${JSON.stringify(id)}`);
    }
    return path;
  }

  async function classifyExisting(
    path: string,
    episode: EpisodeV1,
  ): Promise<'missing' | 'identical' | 'collision'> {
    try {
      const identity = inspectRegularPath(path, 'evidence episode');
      if (!identity) return 'missing';
      const opened = openVerifiedRegular(path, 'evidence episode', identity);
      try {
        if (process.platform !== 'win32') fchmodSync(opened.fd, 0o600);
        const existing = EpisodeV1Schema.parse(
          JSON.parse(readFileSync(opened.fd, 'utf8')),
        );
        return isDeepStrictEqual(existing, episode) ? 'identical' : 'collision';
      } finally {
        closeSync(opened.fd);
      }
    } catch (error) {
      return nodeErrorCode(error) === 'ENOENT' ? 'missing' : 'collision';
    }
  }

  async function prepareEvidenceDir(): Promise<void> {
    prepareEvidenceDirectory(capturesDir, 'evidence store', true);
  }

  /**
   * Enforce the declared newest-`maxEpisodes` retention (#1772 rider — was
   * declared via `retention()` but never enforced). Keeps the
   * `maxEpisodes` episodes with the most recent `session.capturedAt`,
   * deleting the rest. Runs after every successful write; a no-op once the
   * dir is at or under the cap. Never throws into `put()` — pruning is
   * hygiene, not the write contract; a failure to prune is warned and
   * skipped, same posture as the malformed-file skip in `list()`.
   */
  async function pruneOldEpisodes(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(capturesDir).filter((file) => file.endsWith(EPISODE_SUFFIX));
    } catch {
      return;
    }
    if (files.length <= retention.maxEpisodes) return;

    const byRecency = files
      .map((file) => {
        const path = join(capturesDir, file);
        let identity: FileIdentity | undefined;
        try {
          const verified = readVerifiedText(path, 'evidence episode');
          identity = verified.identity;
          const episode = EpisodeV1Schema.parse(JSON.parse(verified.text));
          return { file, capturedAt: episode.session.capturedAt, identity };
        } catch {
          // An unparseable file sorts oldest — never preferentially retained
          // over a valid, dated episode.
          return { file, capturedAt: '', identity };
        }
      })
      .sort((a, b) =>
        b.capturedAt.localeCompare(a.capturedAt)
        || a.file.localeCompare(b.file),
      );

    for (const { file, identity } of byRecency.slice(retention.maxEpisodes)) {
      try {
        if (!identity) {
          throw new Error('refusing to prune a source that did not pass descriptor validation');
        }
        const path = join(capturesDir, file);
        secureRegularPath(path, 'evidence episode', identity);
        await rm(path, { force: true });
        fsyncDirectory(capturesDir);
      } catch (err) {
        console.warn(`[evidence] failed to prune old episode ${file}: ${String(err)}`);
      }
    }
  }

  async function persistEpisode(episode: EpisodeV1): Promise<PortResult<{ episodeId: string }>> {
    const path = episodePath(episode.episodeId);
    const existing = await classifyExisting(path, episode);
    if (existing === 'identical') {
      return ok({ episodeId: episode.episodeId });
    }
    if (existing === 'collision') {
      return unavailable(`evidence episodeId collision: ${episode.episodeId}`);
    }

    const tmp = join(
      capturesDir,
      `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tmp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(episode), 'utf8');
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await handle.sync();
      const expected = identityFrom(await handle.stat());
      assertSafeOwner(await handle.stat(), tmp, 'evidence temp file');

      try {
        // A hard link atomically publishes the complete temp file without
        // overwriting a concurrent winner at the canonical destination.
        await link(tmp, path);
        const [tempAfterLink, published] = await Promise.all([lstat(tmp), lstat(path)]);
        if (
          !tempAfterLink.isFile()
          || tempAfterLink.isSymbolicLink()
          || !published.isFile()
          || published.isSymbolicLink()
          || !sameIdentity(identityFrom(tempAfterLink), expected)
          || !sameIdentity(identityFrom(published), expected)
        ) {
          throw new Error(`evidence episode changed while it was being published: ${path}`);
        }
        assertSafeOwner(tempAfterLink, tmp, 'evidence temp file');
        assertSafeOwner(published, path, 'evidence episode');
        fsyncDirectory(capturesDir);
        return ok({ episodeId: episode.episodeId });
      } catch (error) {
        if (nodeErrorCode(error) !== 'EEXIST') throw error;
        const raced = await classifyExisting(path, episode);
        if (raced === 'identical') {
          return ok({ episodeId: episode.episodeId });
        }
        return unavailable(`evidence episodeId collision: ${episode.episodeId}`);
      }
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await rm(tmp, { force: true });
      fsyncDirectory(capturesDir);
    }
  }

  return {
    async put(episode: EpisodeV1): Promise<PortResult<{ episodeId: string }>> {
      try {
        const parsed = EpisodeV1WriteSchema.parse(episode);
        const result = await withEvidenceStoreLock(capturesDir, async () => {
          await prepareEvidenceDir();
          const persisted = await persistEpisode(parsed);
          if (persisted.status === 'ok') await pruneOldEpisodes();
          return persisted;
        }, async (persisted) => {
          if (persisted.status !== 'ok') return;
          try {
            await deps.onStoreChanged?.();
          } catch (error) {
            console.warn(`[evidence] derived index refresh failed: ${String(error)}`);
          }
        });
        return result;
      } catch (e) {
        return unavailable(`evidence store put failed: ${String(e)}`);
      }
    },

    async get(episodeId: string): Promise<PortResult<EpisodeV1 | null>> {
      try {
        const path = episodePath(episodeId);
        if (!inspectRegularPath(path, 'evidence episode')) return ok(null);
        return ok(EpisodeV1Schema.parse(JSON.parse(
          readVerifiedText(path, 'evidence episode').text,
        )));
      } catch (e) {
        return unavailable(`evidence store get failed: ${String(e)}`);
      }
    },

    async list(query: EvidenceListQuery = {}): Promise<PortResult<EpisodeV1[]>> {
      try {
        try {
          validateDirectory(capturesDir, 'evidence store', false);
        } catch (error) {
          if (nodeErrorCode(error) === 'ENOENT') return ok([]);
          throw error;
        }
        const episodes: EpisodeV1[] = [];
        let unreadable = 0;
        for (const file of readdirSync(capturesDir)) {
          const path = join(capturesDir, file);
          if (file.endsWith(EPISODE_SUFFIX)) {
            try {
              episodes.push(EpisodeV1Schema.parse(JSON.parse(
                readVerifiedText(path, 'evidence episode').text,
              )));
            } catch (err) {
              unreadable += 1;
              console.warn(`[evidence] skipping malformed episode file ${file}: ${String(err)}`);
            }
          } else if (file.endsWith('.json')) {
            // A legacy CapturedTask capture — up-map it. A capture that fails
            // to parse or up-map is skipped (warn), never throws.
            try {
              const task = parseCapturedTask(JSON.parse(
                readVerifiedText(path, 'legacy evidence capture').text,
              ));
              episodes.push(capturedTaskToEpisode(task, retention));
            } catch (err) {
              unreadable += 1;
              console.warn(`[evidence] skipping malformed legacy capture ${file}: ${String(err)}`);
            }
          }
        }
        const value = query.limit ? episodes.slice(0, query.limit) : episodes;
        return unreadable > 0
          ? degraded(`evidence list skipped ${unreadable} unreadable record(s)`, value)
          : ok(value);
      } catch (e) {
        return unavailable(`evidence store list failed: ${String(e)}`);
      }
    },

    async retention(): Promise<PortResult<EvidenceRetentionPolicy>> {
      return ok(retention);
    },
  };
}
