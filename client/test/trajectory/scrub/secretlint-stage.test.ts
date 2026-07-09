import { describe, expect, test } from 'vitest';
import { secretlintStage } from '../../../src/trajectory/scrub/secretlint-stage.js';
import type { KeyPolicy } from '../../../src/trajectory/scrub/key-policy.js';

const policy: KeyPolicy = { safe: ['llm.model'], drop: [] };
const GH = 'ghp_016C7e0aBcDeFgHiJkLmNoPqRsTuVwXyZ012';

describe('secretlintStage', () => {
  test('redacts rule-detected secrets in content values, records secret redactions, skips safe keys', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({
      'tool.output': `token is ${GH} ok`,
      'llm.model': GH, // safe key — must NOT be scrubbed
    });

    expect(result.attributes['tool.output']).not.toContain(GH);
    expect(result.attributes['tool.output']).toContain('[SECRET:');
    expect(result.attributes['llm.model']).toBe(GH);
    expect(result.redactions.some((r) => r.stage === 'secretlint' && r.kind === 'secret')).toBe(true);
  });

  test('redacts high-entropy tokens no rule matched (entropy fallback)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `value ${blob} end` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  test('preserves public SWE-rebench instance ids while keeping entropy guardrails', async () => {
    const stage = secretlintStage(policy);
    for (const instanceId of ['jlowin__fastmcp-3235', 'scikit-learn__scikit-learn-12345']) {
      const text = `swe-rebench ${instanceId}: SWE-rebench v2: short regression summary`;
      const result = await stage.scrub({ 'task.summary': text });
      expect(result.attributes['task.summary']).toBe(text);
      expect(result.redactions).toEqual([]);
    }

    const secretLikeNearMiss = 'Zk3pQ9wX7vR2__sT8yU1nB6-3235';
    const nearMissResult = await stage.scrub({ 'task.summary': `swe-rebench ${secretLikeNearMiss}: summary` });
    expect(nearMissResult.attributes['task.summary']).not.toContain(secretLikeNearMiss);
    expect(nearMissResult.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  test('leaves ordinary prose untouched', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({ 'tool.output': 'the quick brown fox jumps over the lazy dog' });

    expect(result.attributes['tool.output']).toBe('the quick brown fox jumps over the lazy dog');
    expect(result.redactions).toEqual([]);
  });

  // Recall improvement (A1): secret-shaped tokens in the 16–19 char band that
  // the old 20-char entropy floor never considered are now caught, gated on the
  // secret charset + ≥2 character classes so legit identifiers/words are spared.
  test('catches secret-shaped tokens in the 16-19 char band (charset + mixed classes)', async () => {
    const stage = secretlintStage(policy);
    for (const tok of ['aB3dE6gH9jK2mN5p', 'x7y2z9w4v1u8t3s6', 'aB3dE6gH9jK2mN5pQ8']) {
      const result = await stage.scrub({ 'tool.output': `value ${tok} end` });
      expect(result.attributes['tool.output'], `expected ${tok} (len ${tok.length}) redacted`).not.toContain(tok);
      expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
    }
  });

  // Guardrail (A1): the recall improvement must not widen the blast radius onto
  // clearly-legitimate content. Ordinary prose AND representative legit tokens —
  // a long English word, a dictionary word + numeric suffix, a snake_case
  // identifier, a long camelCase type name — survive untouched.
  test('legitimate content survives (no over-redaction from the 16-19 band rule)', async () => {
    const stage = secretlintStage(policy);
    const legit =
      'the authentication subsystem validates incoming requests; ' +
      'supercalifragilistic authentication123 config_value_set_42 AbstractSingletonFactory';
    const result = await stage.scrub({ 'tool.output': legit });
    expect(result.attributes['tool.output']).toBe(legit);
    expect(result.redactions).toEqual([]);
  });

  // A pure-digit run (no letters) is NOT secret-shaped under this rule even at
  // ≥16 chars — it has a single character class. Such numeric runs (phone/card-
  // shaped) are openredaction's job, not the entropy fallback's; leaving them
  // here avoids redacting benign long integers.
  test('does not redact a pure-digit run via the shape gate', async () => {
    const stage = secretlintStage(policy);
    const result = await stage.scrub({ 'tool.output': 'count 1234567890123456 done' });
    expect(result.attributes['tool.output']).toBe('count 1234567890123456 done');
    expect(result.redactions).toEqual([]);
  });

  // #1348: slug-like `owner/repo/path` identifiers (seed-import task summaries)
  // are paths, not secrets — path length inflates entropy past 4.0 bits/char
  // even though every segment is a human-readable slug. They must survive.
  test('slug-like path summaries survive verbatim (#1348)', async () => {
    const stage = secretlintStage(policy);
    for (const summary of [
      'Seed import: obra/superpowers/skills/test-driven-development',
      'Seed import: agentspace-so/runcomfy-agent-skills/video-edit',
    ]) {
      const result = await stage.scrub({ 'tool.output': summary });
      expect(result.attributes['tool.output']).toBe(summary);
      expect(result.redactions).toEqual([]);
    }
  });

  // #1348 review finding: trailing prose punctuation must not defeat the path
  // carve-out. `api/v1/<secret>.` (sentence full stop) qualifies as PATH_SHAPED
  // (segment charset includes `.`), but the strict per-segment gate uses
  // SECRET_CHARSET (which excludes `.`) — so the dot poisoned the final segment
  // and the secret escaped, even though it redacted bare. Trailing dots are
  // stripped before the per-segment gate.
  test('trailing punctuation does not un-redact a path-embedded secret (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `see api/v1/${blob}. done` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1348 review finding guardrail: the trailing-dot strip must not sweep in a
  // slug path ending with a sentence full stop — the stripped segment is a
  // single character class and stays below the gate.
  test('slug path with trailing full stop survives verbatim (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const summary = 'Seed import: obra/superpowers/skills/test-driven-development.';
    const result = await stage.scrub({ 'tool.output': summary });

    expect(result.attributes['tool.output']).toBe(summary);
    expect(result.redactions).toEqual([]);
  });

  // #1348 review finding: the PATH_SHAPED carve-out must not un-redact a
  // genuine secret that merely contains slashes. A canonical AWS secret key
  // has `/` in its base64 alphabet, qualifies as PATH_SHAPED, and — judged
  // per-segment — escaped because no single `/`-run passed the strict gate.
  // The whole token mixes 3 character classes; real slugs don't.
  test('AWS secret key with interior slashes still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const result = await stage.scrub({ 'tool.output': `the deploy used ${awsSecret} and completed` });

    expect(result.attributes['tool.output']).not.toContain(awsSecret);
    expect(result.redactions.some((r) => r.kind === 'secret')).toBe(true);
  });

  // #1348 review finding: same escape class, generic shape — a high-entropy
  // 3-class secret with interior slashes must redact exactly like the same
  // string without slashes.
  test('high-entropy secret with interior slashes still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2/sT8yU1nB6mC4/dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `value ${blob} end` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1348 review finding: a secret used as a filename with an extension —
  // `download/<blob>.tar.gz` — escaped because interior dots poisoned the
  // SECRET_CHARSET per-segment check (only trailing dots were stripped).
  // Candidate segments must be split on dots as well as slashes so the blob
  // between dots gates on its own.
  test('secret as filename with extension still redacts (#1348 review finding)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const result = await stage.scrub({ 'tool.output': `fetch download/${blob}.tar.gz now` });

    expect(result.attributes['tool.output']).not.toContain(blob);
    expect(result.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1378 cosmetic: a `\S+` token inside serialised JSON drags its wrapping
  // delimiters along (`"…/blob",` is one token), so the entropy replacement
  // swallowed the quotes and comma and left malformed JSON
  // (`"resolved_path": [SECRET:high-entropy] "files_modified": …`). Wrapping
  // punctuation is preserved around the placeholder.
  test('entropy redaction inside serialised JSON preserves structure (#1378)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
    const json = `{"resolved_path": "${blob}", "files_modified": 1}`;
    const result = await stage.scrub({ 'tool.result': json });
    const out = result.attributes['tool.result'] as string;

    expect(out).not.toContain(blob);
    expect(JSON.parse(out)).toEqual({
      resolved_path: '[SECRET:high-entropy]',
      files_modified: 1,
    });
  });

  // #1391: URLs are prose, not secrets. `://` sits outside PATH_SHAPED's
  // charset, so every URL ≥ 20 chars took the raw whole-token entropy branch
  // and published as [SECRET:high-entropy] — all 42 seed envelopes lost their
  // attribution link. URL-shaped (and generally punctuation-structured)
  // tokens are judged per delimited segment, like paths.
  test('plain URLs survive verbatim (#1391)', async () => {
    const stage = secretlintStage(policy);
    for (const text of [
      'Attribution: https://github.com/obra/superpowers/tree/main/skills/brainstorming',
      'See https://docs.n8n.io/code-examples/methods-variables-reference/ for details.',
      'Costs at https://www.runcomfy.com/models?utm_source=skills.sh&utm_medium=skill&utm_campaign=ace-step today.',
      'Portal: https://portal.azure.com/#blade/Microsoft_Azure_Capacity/QuotaMenuBlade/myQuotas',
    ]) {
      const result = await stage.scrub({ 'skill.body': text });
      expect(result.attributes['skill.body']).toBe(text);
      expect(result.redactions).toEqual([]);
    }
  });

  test('URL with a CJK path survives verbatim (#1391)', async () => {
    const stage = secretlintStage(policy);
    const text = 'Docs: https://open.larksuite.com/document/服务端文档/云文档概述 (Chinese).';
    const result = await stage.scrub({ 'skill.body': text });
    expect(result.attributes['skill.body']).toBe(text);
    expect(result.redactions).toEqual([]);
  });

  // #1391 guardrail: per-segment gating inside URLs — a genuine token embedded
  // in a URL must STILL redact. URLs are not blanket-whitelisted.
  test('a secret embedded in a URL still redacts (#1391 guardrail)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';

    const ghUrl = `https://api.example.com/v1/${GH}/repos`;
    const ghResult = await stage.scrub({ 'tool.output': `fetch ${ghUrl} now` });
    expect(ghResult.attributes['tool.output']).not.toContain(GH);
    expect(ghResult.redactions.some((r) => r.kind === 'secret')).toBe(true);

    const keyUrl = `https://api.example.com/v1/data?key=${blob}&format=json`;
    const keyResult = await stage.scrub({ 'tool.output': `curl ${keyUrl} done` });
    expect(keyResult.attributes['tool.output']).not.toContain(blob);
    expect(keyResult.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);
  });

  // #1391: CJK prose was shredded — Shannon entropy of a CJK run is far above
  // 4.0 bits/char (each character is near-unique), but the entropy fallback's
  // threat model is ASCII key material. Non-ASCII-dominant tokens skip it.
  test('CJK prose survives verbatim (#1391)', async () => {
    const stage = secretlintStage(policy);
    const text =
      '飞书审批：查询和处理审批待办/已办/实例，搜索可发起审批定义、查看定义详情并发起原生审批实例。' +
      '当用户要处理审批任务、查看审批实例、搜索或发起审批时使用。审批待办不是飞书任务；非审批类待办走 lark-task。';
    const result = await stage.scrub({ 'skill.body': text });
    expect(result.attributes['skill.body']).toBe(text);
    expect(result.redactions).toEqual([]);
  });

  // #1391 guardrail: an ASCII secret inside CJK prose still redacts — both a
  // rule-matched key glued to CJK text and a whitespace-separated generic blob.
  test('ASCII secrets inside CJK prose still redact (#1391 guardrail)', async () => {
    const stage = secretlintStage(policy);
    const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';

    const spaced = `密钥 ${blob} 请妥善保管，不要提交到仓库。`;
    const spacedResult = await stage.scrub({ 'tool.output': spaced });
    expect(spacedResult.attributes['tool.output']).not.toContain(blob);
    expect(spacedResult.redactions.some((r) => r.kind === 'secret' && r.detail === 'high-entropy')).toBe(true);

    const glued = `令牌${GH}后续步骤见文档。`;
    const gluedResult = await stage.scrub({ 'tool.output': glued });
    expect(gluedResult.attributes['tool.output']).not.toContain(GH);
    expect(gluedResult.redactions.some((r) => r.kind === 'secret')).toBe(true);
  });

  // #1391: markdown-link tokens (`text](relative/path.md`) and shell
  // interpolations (`${VAR}/path`) are single \S+ tokens whose punctuation
  // breaks PATH_SHAPED, so they fell into the whole-token entropy branch.
  // Structured tokens are judged per delimited segment.
  test('markdown-link and shell-interpolation tokens survive verbatim (#1391)', async () => {
    const stage = secretlintStage(policy);
    for (const text of [
      'See [`+fetch`](references/lark-doc-fetch.md) and [`+update`](references/lark-doc-update.md).',
      'SRC="${RUN_DIR}/cells/row${row}-frame${i}.png" then montage.',
      'SH="${CLAUDE_SKILL_DIR}/scripts/inject-plan.sh" runs on PreCompact.',
      'Endpoint /api/v1/projects/:projectId/chat/runs/:runId returns the run.',
    ]) {
      const result = await stage.scrub({ 'skill.body': text });
      expect(result.attributes['skill.body']).toBe(text);
      expect(result.redactions).toEqual([]);
    }
  });

  // #1348 guardrail: the path carve-out must NOT weaken genuine secret
  // coverage — a secret embedded as a path segment still redacts.
  test('path-embedded secrets still redact (#1348 guardrail)', async () => {
    const stage = secretlintStage(policy);

    const ghPath = `api/v1/${GH}`;
    const ghResult = await stage.scrub({ 'tool.output': `fetching ${ghPath} now` });
    expect(ghResult.attributes['tool.output']).not.toContain(GH);
    expect(ghResult.redactions.some((r) => r.kind === 'secret')).toBe(true);

    const akiaPath = 'creds/AKIAIOSFODNN7EXAMPLE1234/live';
    const akiaResult = await stage.scrub({ 'tool.output': `reading ${akiaPath} in prose` });
    expect(akiaResult.attributes['tool.output']).not.toContain('AKIAIOSFODNN7EXAMPLE1234');
    expect(akiaResult.redactions.some((r) => r.kind === 'secret')).toBe(true);
  });

  // #1409: seed-profile scrub disables the probabilistic pass-2 entropy sweep.
  // The three observed seed false positives (env-var assignment with a dated
  // slug; ≥20-char camelCase identifiers) must survive byte-identical when the
  // fallback is off, while pass-1 rule-based detection still fires.
  describe('entropyFallback option (#1409)', () => {
    const seedProse = [
      'Run export PLAN_ID=2026-01-10-backend-refactor before starting.',
      'Set PublicNetworkAccessDisabled on the storage account.',
      'Check IPv4StandardSkuPublicIpAddresses quota first.',
    ].join('\n');

    test('entropyFallback: false leaves the observed seed FP shapes byte-identical', async () => {
      const stage = secretlintStage(policy, { entropyFallback: false });
      const result = await stage.scrub({ 'skill.md': seedProse });
      expect(result.attributes['skill.md']).toBe(seedProse);
      expect(result.redactions).toEqual([]);
    });

    test('entropyFallback: false still redacts rule-detected secrets (pass 1 intact)', async () => {
      const stage = secretlintStage(policy, { entropyFallback: false });
      const result = await stage.scrub({ 'skill.md': `token is ${GH} ok` });
      expect(result.attributes['skill.md']).not.toContain(GH);
      expect(result.attributes['skill.md']).toContain('[SECRET:');
      expect(result.redactions.some((r) => r.kind === 'secret')).toBe(true);
    });

    test('entropyFallback defaults ON — omitted option keeps sweeping high-entropy blobs', async () => {
      const blob = 'Zk3pQ9wX7vR2sT8yU1nB6mC4dF0gH5jL';
      const stage = secretlintStage(policy);
      const result = await stage.scrub({ 'tool.output': `value ${blob} end` });
      expect(result.attributes['tool.output']).not.toContain(blob);
      expect(result.redactions.some((r) => r.detail === 'high-entropy')).toBe(true);
    });
  });
});
