/**
 * SkillsPort adapter (#1660) — a file-backed skills-install registry behind the
 * plugin's `SkillsPort`. `install` records the ref (+ `installedAt`); `list`
 * enumerates installed refs; `uninstall` removes a ref unconditionally
 * (idempotent, matching the in-memory reference which `.delete()`s regardless).
 *
 * Stage 1 records/lists/removes refs; on-disk `<name>/SKILL.md` parsing
 * (`parseSkillMarkdown`/`assertConformantName`) is a later stage's concern.
 */
import { join } from 'node:path';
import type { PortResult, SkillRecord, SkillsPort } from '@jinn-network/plugin';
import { ok, unavailable } from '@jinn-network/plugin';
import { readJsonMap, writeJsonMap } from './json-map-store.js';

const INDEX_FILE = 'installed.json';

export interface SkillsAdapterDeps {
  /** Skills-install dir. The registry index lives at `<installDir>/installed.json`. */
  installDir: string;
  /** Injectable clock (tests). */
  now?: () => Date;
}

type SkillEntry = { installedAt: string };

export function createSkillsAdapter(deps: SkillsAdapterDeps): SkillsPort {
  const indexPath = join(deps.installDir, INDEX_FILE);
  const now = deps.now ?? (() => new Date());

  const readIndex = () => readJsonMap<SkillEntry>(indexPath);
  const writeIndex = (index: Record<string, SkillEntry>) => writeJsonMap(indexPath, index);

  return {
    async install(ref: string): Promise<PortResult<SkillRecord>> {
      try {
        const index = readIndex();
        const installedAt = now().toISOString();
        index[ref] = { installedAt };
        writeIndex(index);
        return ok({ ref, installedAt });
      } catch (e) {
        return unavailable(`skills install failed: ${String(e)}`);
      }
    },

    async list(): Promise<PortResult<SkillRecord[]>> {
      try {
        const index = readIndex();
        return ok(Object.entries(index).map(([ref, { installedAt }]) => ({ ref, installedAt })));
      } catch (e) {
        return unavailable(`skills list failed: ${String(e)}`);
      }
    },

    async uninstall(ref: string): Promise<PortResult<{ ref: string }>> {
      try {
        const index = readIndex();
        if (ref in index) {
          delete index[ref];
          writeIndex(index);
        }
        return ok({ ref });
      } catch (e) {
        return unavailable(`skills uninstall failed: ${String(e)}`);
      }
    },
  };
}
