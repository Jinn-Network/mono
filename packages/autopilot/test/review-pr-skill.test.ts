import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const skill = readFileSync(
  join(repoRoot, '.claude', 'skills', 'review-pr', 'SKILL.md'),
  'utf8',
);

function bashBlockAfter(marker: string): string {
  const markerIndex = skill.indexOf(marker);
  expect(markerIndex, `missing flow marker: ${marker}`).toBeGreaterThanOrEqual(0);

  const remainder = skill.slice(markerIndex + marker.length);
  const match = remainder.match(/```bash\n([\s\S]*?)```/);
  expect(match, `missing bash block after: ${marker}`).not.toBeNull();

  return match![1]
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

const advisoryFlow = bashBlockAfter('finish with a **COMMENT** review');
const approvedFlow = bashBlockAfter('- **No blocking findings**');
const changesRequestedFlow = bashBlockAfter('- **Blocking findings**');

const labelsEndpoint = 'repos/Jinn-Network/mono/issues/<N>/labels';

function expectLabelPost(flow: string, label: string): void {
  expect(flow).toContain(
    [
      'gh api --method POST \\',
      `${labelsEndpoint} \\`,
      `-f 'labels[]=${label}'`,
    ].join('\n'),
  );
}

function expectCurrentLabelLookupWithExplicitFailure(flow: string): void {
  expect(flow).toContain(
    [
      'if ! current_labels="$(',
      `gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'`,
      ')"; then',
      'echo "Failed to read current PR labels" >&2',
      'exit 1',
      'fi',
    ].join('\n'),
  );
}

function expectConditionalLabelDelete(flow: string, label: string): void {
  const encodedLabel = label.replace(':', '%3A');
  expect(flow).toContain(
    [
      `if grep -Fxq '${label}' <<<"$current_labels"; then`,
      'gh api --method DELETE \\',
      `${labelsEndpoint}/${encodedLabel}`,
      'fi',
    ].join('\n'),
  );
}

describe('review-pr verdict label writes', () => {
  it('posts the advisory verdict to the issues labels endpoint', () => {
    expectLabelPost(advisoryFlow, 'review:needs-human');
  });

  it('posts the approved verdict to the issues labels endpoint', () => {
    expectLabelPost(approvedFlow, 'review:approved');
  });

  it('posts the changes-requested verdict to the issues labels endpoint', () => {
    expectLabelPost(changesRequestedFlow, 'review:changes-requested');
  });
});

describe('review-pr opposite-label cleanup', () => {
  it('fails explicitly when current labels cannot be read before approved cleanup', () => {
    expectCurrentLabelLookupWithExplicitFailure(approvedFlow);
  });

  it('deletes changes-requested only when it is present after approval', () => {
    expectConditionalLabelDelete(approvedFlow, 'review:changes-requested');
  });

  it('fails explicitly when current labels cannot be read before changes-requested cleanup', () => {
    expectCurrentLabelLookupWithExplicitFailure(changesRequestedFlow);
  });

  it('deletes approved only when it is present after requesting changes', () => {
    expectConditionalLabelDelete(changesRequestedFlow, 'review:approved');
  });
});

describe('review-pr review lifecycle commands', () => {
  it('preserves the advisory comment review command', () => {
    expect(advisoryFlow).toContain(
      'gh pr review <N> --repo Jinn-Network/mono --comment --body "<engine review summary — human code-owner approval required (human-surface)>"',
    );
  });

  it('preserves approval and ready commands', () => {
    expect(approvedFlow).toContain(
      'gh pr review <N> --repo Jinn-Network/mono --approve --body "<summary>"',
    );
    expect(approvedFlow).toContain(
      'gh pr ready <N> --repo Jinn-Network/mono   # un-draft → enters the merge queue',
    );
  });

  it('records labels, posts a fresh approval, and only then un-drafts', () => {
    const labelPost = approvedFlow.indexOf(
      `gh api --method POST \\\n${labelsEndpoint} \\`,
    );
    const labelLookup = approvedFlow.indexOf(
      `gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'`,
    );
    const oppositeDelete = approvedFlow.indexOf(
      `${labelsEndpoint}/review%3Achanges-requested`,
    );
    const ready = approvedFlow.indexOf(
      'gh pr ready <N> --repo Jinn-Network/mono',
    );
    const approve = approvedFlow.indexOf(
      'gh pr review <N> --repo Jinn-Network/mono --approve',
    );

    expect(labelPost).toBeGreaterThanOrEqual(0);
    expect(labelPost).toBeLessThan(labelLookup);
    expect(labelLookup).toBeLessThan(oppositeDelete);
    expect(oppositeDelete).toBeLessThan(approve);
    expect(approve).toBeLessThan(ready);
  });

  it('preserves the request-changes review command', () => {
    expect(changesRequestedFlow).toContain(
      'gh pr review <N> --repo Jinn-Network/mono --request-changes --body "<findings>"',
    );
  });

  it('prohibits gh pr edit regardless of quoting or whitespace', () => {
    const withoutShellQuotes = skill.replace(/['"`]/g, '');
    expect(withoutShellQuotes).not.toMatch(/\bgh\s+pr\s+edit\b/i);
  });
});
