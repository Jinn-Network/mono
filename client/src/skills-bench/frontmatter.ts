import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const ALLOWED_KEYS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface FrontmatterOptions {
  name: string;
  description: string;
  license?: string;
  metadata: Record<string, string>;
}

/** Double-quote + escape a YAML scalar. Always applied to description, license,
 *  and metadata values (rather than only when a quoting character is
 *  detected) — the dominant `description` idiom in this ecosystem is
 *  "Use when: ...", which is invalid unquoted YAML the moment it hits a
 *  colon-space (js-yaml: "bad indentation of a mapping entry"), and the
 *  cheapest way to never emit that is to never emit an unquoted scalar at
 *  all. Embedded newlines are escaped to the two-character `\n` sequence so
 *  a multi-line value can never silently split into extra top-level lines
 *  in this repo's line-oriented lint. */
function quoteYamlScalar(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/** Reverse of quoteYamlScalar. Values that aren't quoted (e.g. `name`, which
 *  is constrained to lowercase/digits/hyphens and never needs it) pass
 *  through unchanged. */
function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || !trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  return trimmed.slice(1, -1).replace(/\\(.)/g, (_match, ch: string) => {
    if (ch === 'n') return '\n';
    return ch; // \" -> ", \\ -> \, anything else -> itself
  });
}

export function buildSkillFrontmatter(opts: FrontmatterOptions): string {
  const lines = ['---', `name: ${opts.name}`, `description: ${quoteYamlScalar(opts.description)}`];
  if (opts.license) lines.push(`license: ${quoteYamlScalar(opts.license)}`);
  const metaKeys = Object.keys(opts.metadata);
  if (metaKeys.length) {
    lines.push('metadata:');
    for (const k of metaKeys) lines.push(`  ${k}: ${quoteYamlScalar(opts.metadata[k])}`);
  }
  lines.push('---', '');
  const fm = lines.join('\n');
  const problems = lintFrontmatter(fm);
  if (problems.length) throw new Error(`invalid frontmatter: ${problems.join('; ')}`);
  return fm;
}

export interface JinnReceiptMetadataOptions {
  /** public URL of the published receipt (spec §5.1 / §6 L3, e.g. a GitHub
   *  blob URL in the published `Jinn-Network/skills` repo). */
  receiptUrl: string;
  /** local path of the receipt file — hashed to produce `jinn.receipt-sha256`. */
  receiptFilePath: string;
  /** plain `YYYY-MM-DD` — the same value passed to render-receipts.ts's `--measured-on`. */
  measuredOn: string;
  /** `owner/repo@sha` of the pinned original this skill was forked from —
   *  omit for a wave-1 (non-fork) skill. */
  forkedFrom?: string;
}

/** Spec §5.1 / §6 L3's `jinn.*` receipt-pointer block — the flat metadata map
 *  a published skill's frontmatter carries so an inspecting agent (or human)
 *  can find, verify, and trust the receipt that measured it. Feed the result
 *  straight into `buildSkillFrontmatter`'s `metadata` option (final-review.md
 *  I6 — this was previously specified but never emitted anywhere). */
export async function buildJinnReceiptMetadata(opts: JinnReceiptMetadataOptions): Promise<Record<string, string>> {
  const bytes = await readFile(opts.receiptFilePath);
  const receiptSha256 = createHash('sha256').update(bytes).digest('hex');
  const metadata: Record<string, string> = {
    'jinn.receipt': opts.receiptUrl,
    'jinn.receipt-sha256': receiptSha256,
    'jinn.measured-on': opts.measuredOn,
  };
  if (opts.forkedFrom) metadata['jinn.forked-from'] = opts.forkedFrom;
  return metadata;
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
    const [, key, rawValue] = kv;
    topKeys.push(key!);
    inMetadata = key === 'metadata';
    const value = unquoteYamlScalar(rawValue!);
    if (key === 'name') name = value;
    if (key === 'description') description = value;
  }
  for (const k of topKeys) if (!ALLOWED_KEYS.has(k)) problems.push(`unknown key: ${k}`);
  if (!name) problems.push('name: required');
  else if (name.length > 64 || !NAME_RE.test(name)) problems.push(`name: invalid (${name})`);
  if (!description) problems.push('description: required');
  else if (description.length > 1024) problems.push('description: exceeds 1024 characters');
  return problems;
}
