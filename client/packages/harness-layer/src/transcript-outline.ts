/**
 * Transcript outline — the solve's raw stdout transcript → a compact
 * decision-path outline for the distiller (issue #1472, spec §8).
 *
 * The learner adapters stream each harness's child stdout into the solve
 * working dir (`.claude-code/stdout.jsonl`, `.codex-code/stdout.jsonl`), and
 * the engine tars it into the `system_snapshot` artifact. Those streams are
 * NOT the tools' home-directory transcript formats, so the shipped
 * transcript-parsers (`client/src/trajectory/transcript-parsers/*`) do not
 * apply (verified against real fixtures: `ClaudeCodeJsonlParser` drops
 * records lacking a top-level `timestamp` — stream-json has none;
 * `CodexSessionParser` expects `session_meta`/`response_item` wrapping, not
 * `codex exec --json` `thread./turn./item.*` events). This module handles the
 * two stdout stream shapes directly, emitting outline lines only — it is
 * prompt-prep, not span capture (that is issue #1473).
 *
 * Signal kept: assistant reasoning text, tool/command invocations, error
 * results, the final result. Noise dropped: system/hook records, thinking
 * blocks, successful tool outputs (the patch already shows the outcome),
 * stream bookkeeping. Every line is single-line and length-capped; the
 * caller applies the overall trace cap.
 */

/** Per-line caps: reasoning text vs tool/command invocations. */
const MAX_TEXT_CHARS = 200;
const MAX_TOOL_CHARS = 150;

function oneLine(s: string, max: number): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, max);
}

function claudeLines(records: unknown[]): string[] {
  const lines: string[] = [];
  for (const rec of records) {
    const r = rec as Record<string, any>;
    if (r?.type === 'assistant') {
      for (const block of r.message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          lines.push(`- assistant: ${oneLine(block.text, MAX_TEXT_CHARS)}`);
        } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
          lines.push(`- tool ${block.name}: ${oneLine(JSON.stringify(block.input ?? {}), MAX_TOOL_CHARS)}`);
        }
        // thinking blocks and other types are dropped (noise for the distiller)
      }
    } else if (r?.type === 'user') {
      const content = r.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result' && block.is_error === true) {
            lines.push(`- tool_result[error]: ${oneLine(String(typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')), MAX_TOOL_CHARS)}`);
          }
        }
      }
    } else if (r?.type === 'result') {
      lines.push(`- result: ${oneLine(String(r.subtype ?? r.result ?? 'done'), MAX_TOOL_CHARS)}`);
    }
    // system/hook records dropped
  }
  return lines;
}

function codexLines(records: unknown[]): string[] {
  const lines: string[] = [];
  for (const rec of records) {
    const r = rec as Record<string, any>;
    // item.completed only — item.started duplicates the same item without output.
    if (r?.type !== 'item.completed') continue;
    const item = r.item as Record<string, any> | undefined;
    if (!item) continue;
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text.trim()) {
      lines.push(`- assistant: ${oneLine(item.text, MAX_TEXT_CHARS)}`);
    } else if (item.type === 'command_execution' && typeof item.command === 'string') {
      const exit = typeof item.exit_code === 'number' && item.exit_code !== 0 ? ` (exit ${item.exit_code})` : '';
      lines.push(`- cmd: ${oneLine(item.command, MAX_TOOL_CHARS)}${exit}`);
    } else if (typeof item.type === 'string') {
      // Unknown completed item kinds surface by name (e.g. file_change) so the
      // outline still shows the step happened.
      lines.push(`- ${oneLine(item.type, MAX_TOOL_CHARS)}`);
    }
  }
  return lines;
}

/**
 * Outline a solve stdout transcript into a compact decision-path string, or
 * `undefined` when nothing usable is in it. Malformed JSONL lines are skipped
 * (never thrown): the transcript is best-effort evidence enrichment.
 */
export function outlineTranscript(
  harness: 'claude-code' | 'codex',
  jsonl: string,
): string | undefined {
  const records: unknown[] = [];
  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines
    }
  }
  if (records.length === 0) return undefined;
  const lines = harness === 'claude-code' ? claudeLines(records) : codexLines(records);
  if (lines.length === 0) return undefined;
  return lines.join('\n');
}
