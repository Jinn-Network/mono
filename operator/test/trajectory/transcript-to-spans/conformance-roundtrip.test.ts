/**
 * Conformance round-trip (AC-2): every transcript-derived span, once added
 * through TrajectoryCollector (add-time scrub + hash-chain + id assignment),
 * must pass the same generic span-profile conformance check as every other
 * span kind. No changes to findFirstProfileViolation / SPAN_PROFILE are
 * needed for this to hold — that's the point of the additive design.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { findFirstProfileViolation } from '../../../src/trajectory/span-profile.js';
import { ClaudeCodeStreamJsonParser } from '../../../src/trajectory/transcript-to-spans/claude-code-stream-json.js';
import { CodexExecJsonParser } from '../../../src/trajectory/transcript-to-spans/codex-exec-json.js';
import { HermesSessionJsonParser } from '../../../src/trajectory/transcript-to-spans/hermes-session-json.js';
import type { TranscriptSpanParser } from '../../../src/trajectory/transcript-to-spans/types.js';

const CLAUDE_CODE_FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/claude-code/stream-json-example.jsonl', import.meta.url),
);
const CODEX_FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/codex/exec-json-with-usage.jsonl', import.meta.url),
);
const HERMES_FIXTURE = fileURLToPath(
  new URL('../../../fixtures/transcripts/hermes-agent/session-example.json', import.meta.url),
);

const cases: Array<{ name: string; parser: TranscriptSpanParser; fixture: string }> = [
  { name: 'claude-code-stream-json', parser: new ClaudeCodeStreamJsonParser(), fixture: CLAUDE_CODE_FIXTURE },
  { name: 'codex-exec-json', parser: new CodexExecJsonParser(), fixture: CODEX_FIXTURE },
  { name: 'hermes-session-json', parser: new HermesSessionJsonParser(), fixture: HERMES_FIXTURE },
];

describe('transcript-to-spans conformance round-trip', () => {
  for (const { name, parser, fixture } of cases) {
    it(`${name}: parsed spans pass findFirstProfileViolation after collector.addSpan`, async () => {
      const spanInputs = await parser.parse(fixture);
      expect(spanInputs.length).toBeGreaterThan(0);

      const collector = new TrajectoryCollector({ taskCid: 'bafyroundtrip', runId: `roundtrip-${name}` });
      for (const input of spanInputs) collector.addSpan(input);

      const { spans } = collector.snapshot();
      expect(findFirstProfileViolation(spans)).toBeNull();
    });
  }
});
