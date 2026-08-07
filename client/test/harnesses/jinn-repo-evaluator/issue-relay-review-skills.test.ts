import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ClaudeIssueRelayReviewSkillRunner,
} from '../../../src/harnesses/impls/jinn-repo-evaluator/issue-relay-review-skills.js';

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

describe('ClaudeIssueRelayReviewSkillRunner', () => {
  it('loads the pinned /code-review command with a credential-free read-only gh projection', async () => {
    const sourceRoot = await tempRoot('relay-skill-source-');
    const executionRoot = await tempRoot('relay-skill-execution-');
    const quality = '---\nallowed-tools: Bash(gh pr view:*)\n---\nReview this PR.\n';
    const security = '---\nallowed-tools: Bash(git diff:*)\n---\nReview security.\n';
    const qualityPath = join(sourceRoot, 'code-review.md');
    const securityPath = join(sourceRoot, 'security-review.md');
    await writeFile(qualityPath, quality, 'utf8');
    await writeFile(securityPath, security, 'utf8');
    const processRunner = vi.fn(async (_command, args: string[], options) => {
      const pluginDir = args[args.indexOf('--plugin-dir') + 1]!;
      expect(await readFile(join(pluginDir, 'commands', 'code-review.md'), 'utf8')).toBe(quality);
      expect(options.input).toBe('/code-review 314');
      expect(options.cwd).toBe('/tmp/exact-relay-checkout');
      expect(options.env).not.toHaveProperty('GH_TOKEN');
      expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
      expect(options.env).not.toHaveProperty('SNYK_TOKEN');
      expect(options.env).toHaveProperty('ANTHROPIC_API_KEY', 'anthropic-test-key');
      const path = options.env['PATH']!;
      const shimPath = join(path.split(':')[0]!, 'gh');
      expect(await readFile(shimPath, 'utf8')).toContain(
        'Relay review skills cannot mutate GitHub.',
      );
      return { stdout: 'No issues found.', stderr: '', exitCode: 0 };
    });
    const runner = new ClaudeIssueRelayReviewSkillRunner({
      qualitySkillPath: qualityPath,
      securitySkillPath: securityPath,
      environment: {
        PATH: process.env.PATH,
        ANTHROPIC_API_KEY: 'anthropic-test-key',
        GH_TOKEN: 'must-not-cross',
        GITHUB_TOKEN: 'must-not-cross',
        SNYK_TOKEN: 'must-not-cross',
      },
      processRunner,
      makeTempDir: async () => executionRoot,
      remove: async () => undefined,
    });

    await expect(runner.run({
      lane: 'quality',
      checkoutPath: '/tmp/exact-relay-checkout',
      baseOid: '1'.repeat(40),
      evaluatedHead: '2'.repeat(40),
      issueNumber: 42,
      prNumber: 314,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'jinn-relay/mono',
      targetBase: 'main',
      headRef: 'jinn/issue-relay/example',
      problemStatement: 'Fix the frozen issue.',
      acceptanceEvidence: ['The exact change passes.'],
      expectedSpecificationDigest: digest(quality),
      abort: new AbortController().signal,
    })).resolves.toEqual({
      skill: '/code-review',
      specificationDigest: digest(quality),
      report: 'No issues found.',
    });
  });

  it('refuses to run when the host specification digest does not pin the skill bytes', async () => {
    const sourceRoot = await tempRoot('relay-skill-source-');
    const path = join(sourceRoot, 'code-review.md');
    await writeFile(path, 'review', 'utf8');
    const processRunner = vi.fn();
    const runner = new ClaudeIssueRelayReviewSkillRunner({
      qualitySkillPath: path,
      securitySkillPath: path,
      environment: { ANTHROPIC_API_KEY: 'anthropic-test-key' },
      processRunner,
    });

    await expect(runner.run({
      lane: 'quality',
      checkoutPath: '/tmp/exact-relay-checkout',
      baseOid: '1'.repeat(40),
      evaluatedHead: '2'.repeat(40),
      issueNumber: 42,
      prNumber: 314,
      targetRepository: 'Jinn-Network/mono',
      workspaceRepository: 'jinn-relay/mono',
      targetBase: 'main',
      headRef: 'jinn/issue-relay/example',
      problemStatement: 'Fix it.',
      acceptanceEvidence: ['Pass.'],
      expectedSpecificationDigest: `sha256:${'f'.repeat(64)}`,
      abort: new AbortController().signal,
    })).rejects.toThrow('does not match the exact evaluation specification');
    expect(processRunner).not.toHaveBeenCalled();
  });
});
