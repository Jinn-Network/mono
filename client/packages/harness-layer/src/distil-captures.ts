import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCapturedTask, type CapturedTask } from './capture.js';
import { parseSkillMarkdown } from './skill-package.js';

/** Own-captures dir the rung-1 `distil` loop reads by default. */
export const DEFAULT_CAPTURES_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'captures');
/** Local skills library `distil` installs into by default. */
export const DEFAULT_SKILLS_INSTALL_DIR = join(homedir(), '.jinn-client', 'harness-layer', 'skills');
/** How many recent own captures `distil` considers when --limit is unset. */
export const DEFAULT_DISTIL_CAPTURE_LIMIT = 50;

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
        `[distil] skipping malformed capture file ${file}: ` +
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
