import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createEvidenceAdapter } from '@jinn-network/core';
import type { EpisodeV1, LocalLearningSkill } from '@jinn-network/plugin';
import { parseCapturedTask, type CapturedTask } from './capture.js';
import { parseSkillMarkdown } from './skill-package.js';

/** Deprecated CapturedTask directory retained as a read-only fallback. */
export const DEFAULT_CAPTURES_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'captures');
/** Canonical complete EpisodeV1 records, distinct from legacy distill captures. */
export const DEFAULT_EPISODES_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'episodes');
/** Local skills library `distill` installs into by default. */
export const DEFAULT_SKILLS_INSTALL_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'skills');
/** How many recent own captures `distill` considers when --limit is unset. */
export const DEFAULT_DISTILL_CAPTURE_LIMIT = 50;

/**
 * Load the operator's most recent own captures from `dir`. Every `*.json` file
 * must be a `CapturedTask`; malformed files are skipped with a stderr warning
 * so machine-readable stdout stays parseable.
 */
export function loadRecentCaptures(dir: string, limit: number): CapturedTask[] {
  if (!existsSync(dir)) return [];
  const parsed: CapturedTask[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      parsed.push(parseCapturedTask(JSON.parse(readFileSync(join(dir, file), 'utf-8'))));
    } catch (err) {
      console.warn(
        `[distill] skipping malformed capture file ${file}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  parsed.sort((a, b) => b.session.capturedAt.localeCompare(a.session.capturedAt));
  return parsed.slice(0, limit);
}

/**
 * Project the canonical local evidence record into the input shape consumed by
 * the existing rung-1 distillation engine. The projection is intentionally
 * lossless for trace facts the distiller understands; episode-only state stays
 * in the canonical record and is never copied to another store.
 */
export function episodeToCapturedTask(episode: EpisodeV1): CapturedTask {
  const steps = episode.trajectory.map(({ truncatedKeys: _truncatedKeys, ...step }) => step);
  return parseCapturedTask({
    session: episode.session,
    task: {
      ...episode.task,
      // Historical CapturedTask files required at least one distribution tag,
      // while EpisodeV1 correctly permits an empty list. The harness identity
      // is a factual local-only fallback needed solely by this compatibility
      // projection.
      distributionTags: episode.task.distributionTags.length > 0
        ? episode.task.distributionTags
        : [episode.environment.harness.name],
    },
    environment: episode.environment,
    steps,
    outcome: {
      status: episode.outcome.status,
      verifiabilityTier: episode.outcome.verificationStrength,
      ...(episode.outcome.summary ? { summary: episode.outcome.summary } : {}),
    },
    cost: episode.cost,
    ...(episode.attemptGroup ? { attemptGroup: episode.attemptGroup } : {}),
    ...(episode.lineage ? { lineage: episode.lineage } : {}),
    provenance: episode.provenance,
  });
}

export interface DistillSourceOptions {
  /** Canonical EpisodeV1 store. */
  episodesDir: string;
  /** Deprecated CapturedTask store, retained for read compatibility only. */
  legacyCapturesDir?: string;
  limit: number;
}

/**
 * Load recent local-learning inputs from the canonical episode store, then
 * merge historical CapturedTask files during the deprecation window. A
 * canonical episode always wins for a duplicate session id, even when the old
 * file has a later timestamp, and the limit is applied only after global sort.
 */
export async function loadRecentDistillSources(
  options: DistillSourceOptions,
): Promise<CapturedTask[]> {
  const evidence = createEvidenceAdapter({ capturesDir: options.episodesDir });
  const listed = await evidence.list();
  if (listed.status === 'unavailable') {
    console.warn(`[distill] canonical episode store unavailable: ${listed.reason}`);
  }

  const canonicalBySession = new Map<string, CapturedTask>();
  if (listed.status !== 'unavailable') {
    for (const episode of listed.value ?? []) {
      const projected = episodeToCapturedTask(episode);
      const existing = canonicalBySession.get(projected.session.sessionId);
      if (!existing || projected.session.capturedAt > existing.session.capturedAt) {
        canonicalBySession.set(projected.session.sessionId, projected);
      }
    }
  }

  const merged = new Map(canonicalBySession);
  if (options.legacyCapturesDir) {
    for (const legacy of loadRecentCaptures(options.legacyCapturesDir, Number.MAX_SAFE_INTEGER)) {
      if (!merged.has(legacy.session.sessionId)) {
        merged.set(legacy.session.sessionId, legacy);
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => b.session.capturedAt.localeCompare(a.session.capturedAt))
    .slice(0, options.limit);
}

/** Staging directory beside the active generated-skill directory. */
export function stagingDirFor(activeDir: string): string {
  return `${activeDir.replace(/[/\\]+$/, '')}-staged`;
}

/** Derive local skill history from the canonical active/staged SKILL.md files. */
export function localSkillProvenance(
  activeDir: string,
  stagedDir: string = stagingDirFor(activeDir),
): LocalLearningSkill[] {
  const skills = new Map<string, LocalLearningSkill>();
  const scan = (dir: string, state: LocalLearningSkill['state']): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const md = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(md)) continue;
      try {
        const pkg = parseSkillMarkdown(readFileSync(md, 'utf-8'));
        const sourceSessionIds = pkg.jinn.provenance
          .map((ref) => /^local-capture:(.+)$/.exec(ref)?.[1])
          .filter((sessionId): sessionId is string => Boolean(sessionId));
        if (sourceSessionIds.length === 0) continue;
        const ref = `local-skill:${pkg.name}`;
        const existing = skills.get(ref);
        if (existing?.state === 'installed') continue;
        skills.set(ref, {
          ref,
          sourceSessionIds: [...new Set(sourceSessionIds)],
          state,
        });
      } catch {
        // History is a structured JSON process command. Skip malformed local
        // artifacts without contaminating its process output.
      }
    }
  };
  scan(activeDir, 'installed');
  scan(stagedDir, 'staged');
  return [...skills.values()].sort((a, b) => a.ref.localeCompare(b.ref));
}

/**
 * The session ids already covered by a generated skill under any of `dirs`.
 * Both active and staged skill dirs count so `--resume` never re-spends a
 * capture that already produced a skill.
 */
export function coveredSessionIds(dirs: string[]): Set<string> {
  const covered = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const md = join(dir, entry.name, 'SKILL.md');
      if (!existsSync(md)) continue;
      try {
        const pkg = parseSkillMarkdown(readFileSync(md, 'utf-8'));
        for (const ref of pkg.jinn.provenance) {
          const m = /^local-capture:(.+)$/.exec(ref);
          if (m?.[1]) covered.add(m[1]);
        }
      } catch {
        // A skill dir we can't parse can't prove coverage.
      }
    }
  }
  return covered;
}

/**
 * Map local provenance refs to human labels for run panels. Unknown refs remain
 * unchanged so non-local provenance stays auditable.
 */
export function provenanceLabels(
  pkg: { jinn: { provenance: string[] } },
  summaryBySession: Map<string, string>,
): string[] {
  return pkg.jinn.provenance.map((ref) => {
    const m = /^local-capture:(.+)$/.exec(ref);
    return m?.[1] ? (summaryBySession.get(m[1]) ?? m[1]) : ref;
  });
}
