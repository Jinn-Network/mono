/** Build one isolated jinn-agent home per pilot arm.
 *
 * The 2026-07-10 pilot ran all arms against the shared ~/.jinn-agent, so every
 * arm's system prompt carried the full installed skills catalog — the arms were
 * not experimentally distinct. Isolation is per-arm homes: identical built-ins
 * and credentials, differing ONLY in which distilled skill sets are installed.
 * `run-pilot.ts` routes an arm to its home via `arm.jinnAgentHome` →
 * `JINN_AGENT_HOME` (see `envForArm`).
 *
 * Deliberately NOT copied: `.skills_prompt_snapshot.json` (the skills-manifest
 * cache — a stale copy would defeat the isolation), `sessions/`, `state.db*`,
 * `logs/`, `cache*`.
 *
 * Known risk: each home holds a copy of `auth.json`, so all arms share one
 * OAuth credential; a token refresh in one home can stale the others. Run the
 * cheap isolation probe first and keep runs short.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export interface ArmHomeSpec {
  name: string;
  skills: string[];
}

export interface ArmWithHome extends ArmHomeSpec {
  jinnAgentHome: string;
}

/** Top-level home files carried into every arm home (skipped if absent). */
const HOME_FILES = ['auth.json', 'config.yaml', '.env', 'SOUL.md', 'models_dev_cache.json'];

function isDistilledSkill(skillDir: string): boolean {
  const manifest = join(skillDir, 'SKILL.md');
  if (!existsSync(manifest)) return false;
  return /schema:\s*jinn\.skill\.v1/.test(readFileSync(manifest, 'utf-8'));
}

export function buildArmHomes(opts: {
  armsFile: ArmHomeSpec[];
  sourceDir: string;
  destDir: string;
}): ArmWithHome[] {
  const { armsFile, sourceDir, destDir } = opts;
  const sourceSkillsDir = join(sourceDir, 'skills');
  const installed = new Set(
    existsSync(sourceSkillsDir)
      ? readdirSync(sourceSkillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : [],
  );

  for (const skill of new Set(armsFile.flatMap((arm) => arm.skills))) {
    if (!installed.has(skill)) {
      throw new Error(`arm skill '${skill}' is not installed in ${sourceSkillsDir}`);
    }
  }
  // Built-ins = every installed skill that is NOT Jinn distillate. Distillate
  // is recognized by its jinn.skill.v1 frontmatter rather than by the arms
  // union, so a rerun with a reduced arm set never misclassifies leftover
  // distilled skills as built-ins.
  const builtins = [...installed].filter((name) => !isDistilledSkill(join(sourceSkillsDir, name))).sort();

  const out: ArmWithHome[] = [];
  for (const arm of armsFile) {
    const home = join(destDir, arm.name);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    for (const file of HOME_FILES) {
      const src = join(sourceDir, file);
      if (existsSync(src)) cpSync(src, join(home, file));
    }
    const homeSkills = join(home, 'skills');
    mkdirSync(homeSkills, { recursive: true });
    for (const skill of [...builtins, ...arm.skills]) {
      cpSync(join(sourceSkillsDir, skill), join(homeSkills, skill), { recursive: true });
    }
    out.push({ name: arm.name, skills: arm.skills, jinnAgentHome: home });
  }
  return out;
}
