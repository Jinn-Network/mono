import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCapturedTask, type CapturedTask } from './capture.js';
import { parseSkillMarkdown } from './skill-package.js';
import type { LocalLearningSkill } from '@jinn-network/plugin';

/** Own-captures dir the rung-1 `distill` loop reads by default. */
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
