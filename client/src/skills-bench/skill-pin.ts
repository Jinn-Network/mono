import { createHash } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface PinSkillOptions {
  name: string;
  /** git URL or local path (anything `git clone` accepts). */
  source: string;
  commit: string;
  /** path of the skill directory inside the repo, e.g. `skills/tdd`. */
  skillPath: string;
  destRoot: string;
}

export interface SkillPin {
  name: string;
  source: string;
  commit: string;
  skillPath: string;
  /** sha256 over sorted (relative-path, bytes) pairs of the vendored dir, pin.json excluded. */
  sha256: string;
  /** frontmatter `license` value, null when absent — Task 6 gates forking on it. */
  license: string | null;
  fetchedAt: string;
}

async function hashDir(dir: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (rel: string): Promise<void> => {
    const entries = (await readdir(join(dir, rel), { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === 'pin.json') continue;
      if (e.isDirectory()) await walk(childRel);
      else {
        hash.update(childRel);
        hash.update(await readFile(join(dir, childRel)));
      }
    }
  };
  await walk('');
  return hash.digest('hex');
}

function parseFrontmatterLicense(skillMd: string): string | null {
  const fm = skillMd.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const line = fm[1]!.split('\n').find((l) => l.startsWith('license:'));
  return line ? line.slice('license:'.length).trim() || null : null;
}

export async function pinSkill(opts: PinSkillOptions): Promise<SkillPin> {
  const cloneDir = await mkdtemp(join(tmpdir(), 'skill-pin-'));
  try {
    await exec('git', ['clone', '-q', opts.source, cloneDir]);
    await exec('git', ['-C', cloneDir, 'checkout', '-q', opts.commit]);
    const src = join(cloneDir, opts.skillPath);
    if (!existsSync(join(src, 'SKILL.md'))) {
      throw new Error(`no SKILL.md at ${opts.skillPath} in ${opts.source}@${opts.commit}`);
    }
    const dest = join(opts.destRoot, opts.name);
    await rm(dest, { recursive: true, force: true });
    await mkdir(opts.destRoot, { recursive: true });
    await cp(src, dest, { recursive: true });
    const skillMd = await readFile(join(dest, 'SKILL.md'), 'utf8');
    const pin: SkillPin = {
      name: opts.name,
      source: opts.source,
      commit: opts.commit,
      skillPath: opts.skillPath,
      sha256: await hashDir(dest),
      license: parseFrontmatterLicense(skillMd),
      fetchedAt: new Date().toISOString(),
    };
    await writeFile(join(dest, 'pin.json'), `${JSON.stringify(pin, null, 2)}\n`);
    return pin;
  } finally {
    await rm(cloneDir, { recursive: true, force: true });
  }
}
