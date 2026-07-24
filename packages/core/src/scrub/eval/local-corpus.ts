/**
 * Operator-local labeled corpus loader (#1968).
 *
 * Reads a JSONL file of EvalFixture objects from an operator-local path
 * (default `~/.jinn-client/local-corpus/scrub-eval.jsonl`). Never ships
 * fixture text in the metrics artifact — only counts.
 *
 * The mining-batch{1,2}-pii-inventory.md files are human analysis (counts +
 * redacted examples). Operators derive synthetic/local JSONL labels from them;
 * this loader does not parse the markdown inventories (they intentionally
 * omit raw spans).
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EvalFixture } from './types.js';

export const DEFAULT_LOCAL_CORPUS_PATH = join(
  homedir(),
  '.jinn-client',
  'local-corpus',
  'scrub-eval.jsonl',
);

export function loadLocalCorpus(path: string = DEFAULT_LOCAL_CORPUS_PATH): EvalFixture[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8');
  const fixtures: EvalFixture[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    fixtures.push(JSON.parse(trimmed) as EvalFixture);
  }
  return fixtures;
}
