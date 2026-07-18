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
const reviewerTokenPrefix = 'GH_TOKEN="$JINN_REVIEW_GH_TOKEN" ';

function withReviewerToken(command: string): string {
  return `${reviewerTokenPrefix}${command}`;
}

function expectLabelPost(flow: string, label: string): void {
  expect(flow).toContain(
    [
      withReviewerToken('gh api --method POST \\'),
      `${labelsEndpoint} \\`,
      `-f 'labels[]=${label}'`,
    ].join('\n'),
  );
}

function expectCurrentLabelLookupWithExplicitFailure(flow: string): void {
  expect(flow).toContain(
    [
      'if ! current_labels="$(',
      withReviewerToken(
        `gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'`,
      ),
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
      withReviewerToken('gh api --method DELETE \\'),
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
      withReviewerToken(
        'gh pr review <N> --repo Jinn-Network/mono --comment --body "<engine review summary — human code-owner approval required (human-surface)>"',
      ),
    );
  });

  it('preserves approval and ready commands', () => {
    expect(approvedFlow).toContain(
      withReviewerToken(
        'gh pr review <N> --repo Jinn-Network/mono --approve --body "<summary>"',
      ),
    );
    expect(approvedFlow).toContain(
      withReviewerToken(
        'gh pr ready <N> --repo Jinn-Network/mono   # un-draft → enters the merge queue',
      ),
    );
  });

  it('records labels, posts a fresh approval, and only then un-drafts', () => {
    const labelPost = approvedFlow.indexOf(
      `${reviewerTokenPrefix}gh api --method POST \\\n${labelsEndpoint} \\`,
    );
    const labelLookup = approvedFlow.indexOf(
      withReviewerToken(
        `gh api repos/Jinn-Network/mono/issues/<N> --jq '.labels[].name'`,
      ),
    );
    const oppositeDelete = approvedFlow.indexOf(
      `${labelsEndpoint}/review%3Achanges-requested`,
    );
    const ready = approvedFlow.indexOf(
      withReviewerToken('gh pr ready <N> --repo Jinn-Network/mono'),
    );
    const approve = approvedFlow.indexOf(
      withReviewerToken('gh pr review <N> --repo Jinn-Network/mono --approve'),
    );

    expect(labelPost).toBeGreaterThanOrEqual(0);
    expect(labelPost).toBeLessThan(labelLookup);
    expect(labelLookup).toBeLessThan(oppositeDelete);
    expect(oppositeDelete).toBeLessThan(approve);
    expect(approve).toBeLessThan(ready);
  });

  it('preserves the request-changes review command', () => {
    expect(changesRequestedFlow).toContain(
      withReviewerToken(
        'gh pr review <N> --repo Jinn-Network/mono --request-changes --body "<findings>"',
      ),
    );
  });

  it('prohibits gh pr edit regardless of quoting or whitespace', () => {
    const withoutShellQuotes = skill.replace(/['"`]/g, '');
    expect(withoutShellQuotes).not.toMatch(/\bgh\s+pr\s+edit\b/i);
  });
});

describe('review-pr reviewer identity binding', () => {
  it('fails loudly unless the reviewer token resolves to the configured reviewer login', () => {
    const preflight = bashBlockAfter('## Reviewer credential invariant');

    expect(preflight).toContain(
      ': "${JINN_REVIEW_GH_TOKEN:?JINN_REVIEW_GH_TOKEN is required for review-pr}"',
    );
    expect(preflight).toContain(
      ': "${JINN_REVIEW_BOT_LOGIN:?JINN_REVIEW_BOT_LOGIN is required for review-pr}"',
    );
    expect(preflight).toContain(
      ': "${JINN_REVIEW_HEAD_REF:?JINN_REVIEW_HEAD_REF is required for review-pr}"',
    );
    expect(preflight).toContain(
      withReviewerToken("gh api user --jq '.login'"),
    );
    expect(preflight).toContain(
      `printf '%s' "$review_login" | tr '[:upper:]' '[:lower:]'`,
    );
    expect(preflight).toContain(
      `printf '%s' "$JINN_REVIEW_BOT_LOGIN" | tr '[:upper:]' '[:lower:]'`,
    );
    expect(preflight).toContain(
      'git check-ref-format "refs/heads/$JINN_REVIEW_HEAD_REF"',
    );
    expect(preflight).toContain('exit 1');
  });

  it('runs identity preflight before reading or mutating the PR', () => {
    expect(skill.indexOf('## Reviewer credential invariant')).toBeLessThan(
      skill.indexOf('## Step 1 — Read the PR'),
    );
  });

  it('explicitly binds every shell gh invocation to the reviewer token', () => {
    const bashBlocks = [...skill.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    const ghInvocations = bashBlocks.flatMap((block) =>
      block
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /\bgh\s/.test(line)),
    );

    expect(ghInvocations.length).toBeGreaterThan(0);
    for (const invocation of ghInvocations) {
      const matches = [...invocation.matchAll(/\bgh\s/g)];
      for (const match of matches) {
        const prefixStart = match.index - reviewerTokenPrefix.length;
        expect(
          invocation.slice(prefixStart, match.index),
          `bare gh invocation: ${invocation}`,
        ).toBe(reviewerTokenPrefix);
      }
    }
  });

  it('binds reviewer fix pushes to the reviewer token at the command point', () => {
    expect(skill).toContain('GIT_ASKPASS="$review_askpass" \\');
    expect(skill).toContain(
      'JINN_REVIEW_GH_TOKEN="$JINN_REVIEW_GH_TOKEN" \\',
    );
    expect(skill).toContain(
      'git -c credential.helper= push "https://github.com/Jinn-Network/mono.git" \\',
    );
    expect(skill).toContain('"HEAD:refs/heads/$JINN_REVIEW_HEAD_REF"');
    expect(skill).toContain(
      `*Password*) printf '%s\\\\n' \\"\\$JINN_REVIEW_GH_TOKEN\\" ;;`,
    );
    expect(skill).not.toContain('git push origin');
    expect(skill).not.toContain('gh auth setup-git');
    expect(skill).not.toMatch(/https:\/\/[^\s]*JINN_REVIEW_GH_TOKEN/);
    expect(skill).not.toContain('HEAD:<headRefName>');
  });

  it('fails the fix loop when the fixer produces no new commit', () => {
    expect(skill).toContain(
      'before_fix_head="$(git rev-parse --verify HEAD)"',
    );
    expect(skill).toContain(
      'before_fix_marker="$(git rev-parse --git-path jinn-review-before-fix)"',
    );
    expect(skill).toContain(
      `printf '%s\\n' "$before_fix_head" >"$before_fix_marker"`,
    );
    expect(skill).toContain(
      'IFS= read -r before_fix_head <"$before_fix_marker"',
    );
    expect(skill).toContain(
      'after_fix_head="$(git rev-parse --verify HEAD)"',
    );
    expect(skill).toContain(
      'if [[ "$after_fix_head" == "$before_fix_head" ]]; then',
    );
    expect(skill).toContain('Fix subagent produced no new commit');
    expect(skill.indexOf('before_fix_head=')).toBeLessThan(
      skill.indexOf('Dispatch a **fix subagent**'),
    );
    expect(skill.indexOf('after_fix_head=')).toBeLessThan(
      skill.indexOf('GIT_ASKPASS="$review_askpass"'),
    );
    expect(skill).not.toContain('git log origin/next..HEAD');
  });

  it('token-binds escalation comments and project-field mutations', () => {
    const escalation = bashBlockAfter('## Step 4 — Finding handling & escalation');
    expect(escalation).toContain(
      withReviewerToken(
        'gh pr comment <N> --repo Jinn-Network/mono --body "$ESCALATION_NOTE"',
      ),
    );
    expect(escalation).toContain(
      withReviewerToken(
        'gh project item-edit --id <item-id> --project-id <project-id> \\',
      ),
    );
  });

  it('states the real allowlist trust boundary without claiming token containment', () => {
    expect(skill).toContain('configured author allowlist');
    expect(skill).toMatch(
      /Deployment requirement: provide a dedicated\s+reviewer credential\. Grant only the minimum scopes needed/,
    );
    expect(skill).toContain('identity binding, not containment');
    expect(skill).toContain('credential broker');
  });
});
