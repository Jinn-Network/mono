/**
 * plain-patterns stage — regression net for issue #1330.
 *
 * Empirical finding (from #1310): the base pipeline missed two shapes the
 * plan's own seeded-secrets fixture requires redacted — plain emails
 * (openredaction's EMAIL pattern is unreliable, e.g. `jane.doe@example-corp.com`)
 * and `/Users/<name>/` home-directory paths (nothing touched paths). This
 * stage closes the gap in the SHARED pipeline so the daemon capture publish
 * path (operator/src/captures/publish.ts) and the harness-layer capture path
 * are protected by one implementation.
 */

import { describe, expect, it } from 'vitest';
import { plainPatternsStage } from '../../../src/trajectory/scrub/plain-patterns-stage.js';
import { buildScrubPipeline, DEFAULT_KEY_POLICY } from '../../../src/trajectory/scrub/build.js';

const EMAIL = 'jane.doe@example-corp.com';
const MAC_PATH = '/Users/janedoe/project/notes.txt';
const LINUX_PATH = '/home/janedoe/.config/tool.toml';

describe('plainPatternsStage', () => {
  it('redacts plain emails in content values', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({ 'llm.prompt': `Mail ${EMAIL} about the release.` });
    expect(String(result.attributes['llm.prompt'])).not.toContain(EMAIL);
    expect(result.redactions.some((r) => r.stage === 'plain-patterns' && r.detail === 'email')).toBe(true);
  });

  it('redacts home-directory usernames in paths (macOS and Linux shapes)', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({
      'tool.args': `cat ${MAC_PATH} && cat ${LINUX_PATH}`,
    });
    const out = String(result.attributes['tool.args']);
    expect(out).not.toContain('janedoe');
    expect(out).toContain('/users/anon');
    expect(result.redactions.filter((r) => r.detail === 'home-path')).toHaveLength(2);
  });

  it('leaves non-content keys and non-string values untouched', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({
      'jinn.operator': EMAIL, // `safe` key — structural, passes raw
      count: 3,
    });
    expect(result.attributes['jinn.operator']).toBe(EMAIL);
    expect(result.attributes['count']).toBe(3);
    expect(result.redactions).toHaveLength(0);
  });
});

describe('credential-ID patterns (#1415)', () => {
  const AWS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
  const GCP_API_KEY = 'AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe';

  it('always redacts bare AWS access-key IDs (shared inventory, #1969)', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({ 'skill.md': `export AWS_ACCESS_KEY_ID=${AWS_KEY_ID}` });
    const out = String(result.attributes['skill.md']);
    expect(out).not.toContain(AWS_KEY_ID);
    expect(out).toContain('[SECRET:aws-access-key-id]');
    expect(
      result.redactions.some(
        (r) => r.stage === 'plain-patterns' && r.kind === 'secret' && r.detail === 'aws-access-key-id',
      ),
    ).toBe(true);
  });

  it('always redacts a GCP AIza API key (shared inventory, #1969)', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const result = await stage.scrub({ 'skill.md': `curl "https://example.test/v1?key=${GCP_API_KEY}"` });
    const out = String(result.attributes['skill.md']);
    expect(out).not.toContain(GCP_API_KEY);
    expect(out).toContain('[SECRET:gcp-api-key]');
    expect(
      result.redactions.some(
        (r) => r.stage === 'plain-patterns' && r.kind === 'secret' && r.detail === 'gcp-api-key',
      ),
    ).toBe(true);
  });

  it('leaves prose and shorter look-alike tokens alone', async () => {
    const stage = plainPatternsStage(DEFAULT_KEY_POLICY);
    const input = 'The AKIA prefix marks AWS key IDs; AIzaSy is the GCP prefix.';
    const result = await stage.scrub({ 'skill.md': input });
    expect(result.attributes['skill.md']).toBe(input);
    expect(result.redactions).toHaveLength(0);
  });
});

describe('default shared pipeline (the daemon publish path assembly)', () => {
  it('redacts a plain email and a home path — the #1330 regression', async () => {
    const pipeline = buildScrubPipeline();
    const result = await pipeline.run({
      'llm.prompt': `Email ${EMAIL}; file at ${MAC_PATH}`,
    });
    const out = String(result.attributes['llm.prompt']);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain('janedoe');
  });
});
