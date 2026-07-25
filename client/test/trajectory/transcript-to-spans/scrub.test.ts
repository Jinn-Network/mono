/**
 * AC-3: transcript-derived spans pass the same add-time + emit-time scrub as
 * existing spans.
 *
 * The two scrub stages catch different shapes by design (see
 * src/trajectory/secret-scrub.ts and src/trajectory/scrub/pipeline.ts):
 *   - Add-time (TrajectoryCollector.addSpan → secret-scrub.ts) is a
 *     key-NAME-based redactor. Per #1473 finding 2 it now walks nested
 *     objects/arrays too (not just the span's top-level attribute keys) —
 *     a low-entropy secret under a secret-named NESTED key (e.g.
 *     `tool.args: { apiKey: '...' }`) was surviving both scrub layers,
 *     since emit-time's nested walker is content-based (below) and doesn't
 *     independently classify nested key NAMES.
 *   - Emit-time (buildScrubPipeline().run() → scrub/pipeline.ts) is
 *     content-based (owned deterministic detectors + secretlint) and walks
 *     string leaves of nested object/array attribute values, keyed by the
 *     top-level attribute name for key-policy classification. This is the
 *     stage that reaches secrets embedded inside `tool.args` (an object,
 *     per DR-2026-07-14) or `tool.result`.
 *
 * So: the first test proves transcript span kinds get no special treatment
 * from add-time's key-name scrub (identical mechanism to every other kind);
 * the second proves the add-time layer now also reaches a secret-named key
 * NESTED inside `tool.args` (the finding 2 gap); the third proves a secret
 * realistically embedded inside `tool.args` (e.g. a bearer token baked into
 * a shell command argument) is caught by the emit-time pipeline's nested
 * walker — the mechanism the design summary calls out explicitly
 * ("tool.args (object ... the scrub pipeline's nested walker handles
 * objects)").
 */

import { describe, it, expect } from 'vitest';
import { TrajectoryCollector } from '../../../src/trajectory/collector.js';
import { buildScrubPipeline } from '../../../src/trajectory/scrub/build.js';

// Deterministic secretlint-preset match (no ML/PII detector required) — same
// fixture used by test/trajectory/scrub/secretlint-stage.test.ts.
const GH_TOKEN = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

describe('transcript-to-spans secret scrub (AC-3)', () => {
  it('add-time scrub redacts a secret-named top-level attribute on a jinn.tool_call span, same as any other kind', () => {
    const collector = new TrajectoryCollector({ taskCid: 'bafyscrubtest', runId: 'scrub-add-time' });
    const span = collector.addSpan({
      name: 'tool_call.shell',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.tool_call',
        'tool.name': 'shell',
        'tool.args': { command: 'echo hi' },
        'jinn.transcript.sourceFormat': 'codex-exec-json',
        'jinn.transcript.parser': 'codex-exec-json',
        'jinn.transcript.parserVersion': '1.0.0',
        // Simulates a flattened credential attribute — the same shape the
        // existing jinn.mcp_call wrapper produces (mcp.tool.args.<name>) that
        // secret-scrub.ts's key-name matcher is designed to catch.
        'tool.args.password': 'hunter2',
      },
      events: [],
      status: { code: 'OK' },
    });

    expect(span.attributes['tool.args.password']).toBe('<redacted:tool.args.password>');
    const { redactionManifest } = collector.snapshot();
    expect(redactionManifest.totalRedactions).toBeGreaterThan(0);
    expect(redactionManifest.spans[0].redactedKeys).toContain('tool.args.password');
  });

  it('add-time scrub redacts a secret-named key NESTED inside tool.args on a jinn.tool_call span (#1473 finding 2)', () => {
    const collector = new TrajectoryCollector({ taskCid: 'bafyscrubtest', runId: 'scrub-add-time-nested' });
    const span = collector.addSpan({
      name: 'tool_call.shell',
      kind: 'INTERNAL',
      startTimeUnixNano: '1',
      endTimeUnixNano: '2',
      attributes: {
        'jinn.span.kind': 'jinn.tool_call',
        'tool.name': 'shell',
        // A parsed claude-code/codex tool_call span's tool.args is an
        // object per DR-2026-07-14 — this is the production shape. The
        // apiKey value here is deliberately low-entropy so it would NOT be
        // caught by the emit-time content-based detectors (gitleaks /
        // secretlint / plain-patterns); only key-name matching catches it.
        'tool.args': { apiKey: 'low-entropy-value', command: 'echo hi' },
        'jinn.transcript.sourceFormat': 'claude-code-stream-json',
        'jinn.transcript.parser': 'claude-code-stream-json',
        'jinn.transcript.parserVersion': '1.0.0',
      },
      events: [],
      status: { code: 'OK' },
    });

    const args = span.attributes['tool.args'] as Record<string, unknown>;
    expect(args.apiKey).toBe('<redacted:tool.args.apiKey>');
    expect(args.command).toBe('echo hi');
    const { redactionManifest } = collector.snapshot();
    expect(redactionManifest.spans[0].redactedKeys).toContain('tool.args.apiKey');
  });

  it('emit-time scrub pipeline redacts a secret embedded inside a tool.args object leaf', async () => {
    const rawAttrs = {
      'jinn.span.kind': 'jinn.tool_call',
      'tool.name': 'shell',
      'tool.args': { command: `curl -H "Authorization: Bearer ${GH_TOKEN}" https://api.example.com` },
      'jinn.transcript.sourceFormat': 'codex-exec-json',
      'jinn.transcript.parser': 'codex-exec-json',
      'jinn.transcript.parserVersion': '1.0.0',
    };

    const { attributes, redactions } = await buildScrubPipeline().run(rawAttrs);

    const scrubbedArgs = attributes['tool.args'] as { command: string };
    expect(scrubbedArgs.command).not.toContain(GH_TOKEN);
    // The owned gitleaks detector recognizes this exact GitHub PAT shape after
    // openredaction's retirement (#1972/#1973).
    expect(
      redactions.some(
        (r) =>
          r.key === 'tool.args' &&
          r.stage === 'gitleaks' &&
          r.kind === 'secret' &&
          r.detail === 'github-pat',
      ),
    ).toBe(true);
    // jinn.* structural attrs stay raw — the safe-key policy bypasses scrub for them.
    expect(attributes['jinn.transcript.sourceFormat']).toBe('codex-exec-json');
  });
});
