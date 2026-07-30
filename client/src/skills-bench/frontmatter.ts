const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface FrontmatterOptions {
  name: string;
  description: string;
  license?: string;
  metadata: Record<string, string>;
}

export function buildSkillFrontmatter(opts: FrontmatterOptions): string {
  const lines = ['---', `name: ${opts.name}`, `description: ${opts.description}`];
  if (opts.license) lines.push(`license: ${opts.license}`);
  const metaKeys = Object.keys(opts.metadata);
  if (metaKeys.length) {
    lines.push('metadata:');
    for (const k of metaKeys) lines.push(`  ${k}: ${opts.metadata[k]}`);
  }
  lines.push('---', '');
  const fm = lines.join('\n');
  const problems = lintFrontmatter(fm);
  if (problems.length) throw new Error(`invalid frontmatter: ${problems.join('; ')}`);
  return fm;
}

/** Spec: https://agentskills.io/specification — six allowed keys; name 1-64
 *  lowercase/digits/hyphens, no leading/trailing/double hyphen; description
 *  1-1024 chars; metadata is a flat string map. Returns human-readable
 *  problems; empty array = valid. Line-oriented on purpose — the frontmatter
 *  this repo emits is flat, and a YAML dependency would be scope creep. */
export function lintFrontmatter(text: string): string[] {
  const problems: string[] = [];
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return ['no frontmatter block'];
  const lines = m[1]!.split('\n');
  const topKeys: string[] = [];
  let name = '';
  let description = '';
  let inMetadata = false;
  for (const line of lines) {
    if (/^\s{2,}\S/.test(line)) {
      if (!inMetadata) problems.push(`nested value outside metadata: "${line.trim()}"`);
      continue;
    }
    const kv = line.match(/^([A-Za-z-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    topKeys.push(key!);
    inMetadata = key === 'metadata';
    if (key === 'name') name = value!;
    if (key === 'description') description = value!;
  }
  for (const k of topKeys) if (!ALLOWED_KEYS.has(k)) problems.push(`unknown key: ${k}`);
  if (!name) problems.push('name: required');
  else if (name.length > 64 || !NAME_RE.test(name)) problems.push(`name: invalid (${name})`);
  if (!description) problems.push('description: required');
  else if (description.length > 1024) problems.push('description: exceeds 1024 characters');
  return problems;
}
