/**
 * transcript-to-spans registry — maps a harness impl name (task.implName,
 * always `impl.name` — see CLAUDE_CODE_HARNESS / CODEX_HARNESS in
 * ../../harnesses/names.ts) to its transcript-to-spans parser and the
 * transcript path it expects inside workingDir.
 *
 * Keyed on the imported names.ts constants, NOT string literals — the
 * production implName for codex solves is 'codex' (CODEX_HARNESS), not
 * 'codex-code' (#1473 finding 1: 'codex-code' matched only the adapter's
 * *filename*, never a real task.implName, so codex transcript parsing was
 * dead code). The transcript PATH is unaffected: adapters still write to
 * `.claude-code/stdout.jsonl` / `.codex-code/stdout.jsonl` regardless of the
 * registry key — those directory names are adapter-owned (see
 * src/harnesses/impls/learner/adapters/{claude-code,codex-code}.ts).
 *
 * Any other impl name (or a null/undefined one) resolves to null: the
 * engine's pack() hook treats that as "no transcript parser for this
 * harness" and skips transcript-to-spans entirely (degrade, not fail).
 */

import { join } from 'node:path';
import { ClaudeCodeStreamJsonParser } from './claude-code-stream-json.js';
import { CodexExecJsonParser } from './codex-exec-json.js';
import { HermesSessionJsonParser } from './hermes-session-json.js';
import type { TranscriptSpanParserResolution } from './types.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, HERMES_AGENT_HARNESS } from '../../harnesses/names.js';
import type { TrajectoryCollector } from '../collector.js';

export function getTranscriptSpanParser(
  implName: string | null | undefined,
  workingDir: string,
): TranscriptSpanParserResolution | null {
  if (implName === CLAUDE_CODE_HARNESS) {
    return {
      parser: new ClaudeCodeStreamJsonParser(),
      transcriptPath: join(workingDir, '.claude-code', 'stdout.jsonl'),
    };
  }
  if (implName === CODEX_HARNESS) {
    return {
      parser: new CodexExecJsonParser(),
      transcriptPath: join(workingDir, '.codex-code', 'stdout.jsonl'),
    };
  }
  if (implName === HERMES_AGENT_HARNESS) {
    // The hermes-agent adapter lifts the finished
    // `$HERMES_HOME/sessions/session_*.json` record into this path after a
    // successful solve (see src/harnesses/impls/hermes-agent/adapter.ts).
    return {
      parser: new HermesSessionJsonParser(),
      transcriptPath: join(workingDir, '.hermes-agent', 'session.json'),
    };
  }
  return null;
}

/**
 * Resolve + parse the solve transcript into the given collector, guarded so
 * it is a no-op if transcript spans are already present (#1473 finding 3).
 *
 * pack() retries in place — the engine-tick loop IS the retry, and
 * `trajectoryCollectors` is only cleared once PACKAGING reaches DELIVERING
 * (see engine.ts) — so a failure between this hook running and DELIVERING
 * being reached would otherwise re-parse the same transcript on the next
 * attempt and duplicate every jinn.agent_turn/jinn.tool_call span. Guard by
 * checking whether the collector already holds any span stamped with
 * jinn.transcript.sourceFormat (the provenance attribute every
 * transcript-to-spans parser stamps via attrs.ts's makeProvenanceAttrs) —
 * cheap over an in-memory per-run span list, and correct because this hook
 * is the only span producer that ever sets that attribute.
 */
export async function addTranscriptSpans(
  collector: TrajectoryCollector,
  implName: string | null | undefined,
  workingDir: string,
): Promise<void> {
  const alreadyParsed = collector
    .snapshot()
    .spans.some((s) => typeof s.attributes['jinn.transcript.sourceFormat'] === 'string');
  if (alreadyParsed) return;

  const resolution = getTranscriptSpanParser(implName, workingDir);
  if (!resolution) return;

  const spanInputs = await resolution.parser.parse(resolution.transcriptPath);
  for (const spanInput of spanInputs) collector.addSpan(spanInput);
}
