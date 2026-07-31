import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashTaskSet, loadTaskSet, validateTaskSet, isTaskGradeabilityPassing, assertTaskSetGradeable,
  assertNoArmNameLeak,
  TaskSetValidationError,
  type SkillTaskSetV1, type SkillTaskV1, type TaskRequirement,
} from '../../src/skills-bench/task-set.js';

function requirement(over: Partial<TaskRequirement> = {}): TaskRequirement {
  return {
    background: 'The widget module has a bug in its size calculation.',
    requirement: 'Fix the widget so it reports the correct size for empty inputs.',
    fileOps: 'Edit src/widget.py only.',
    acceptance: 'The verifier tests in test_widget_size.py must pass.',
    ...over,
  };
}

function task(over: Partial<SkillTaskV1> = {}): SkillTaskV1 {
  return {
    id: 'fix-widget-0001',
    repo: 'org/widget-repo',
    commit: 'a'.repeat(40),
    image: 'jinn/widget-task:0001',
    requirement: requirement(),
    verifierFiles: ['verifiers/test_widget_size.py'],
    referencePatchFile: 'patches/fix-widget-0001.patch',
    ...over,
  };
}

/** Writes a minimal on-disk task-set fixture: set.json + the referenced
 *  verifier and reference-patch files, hash computed and embedded. */
async function makeFixtureSet(opts: {
  skill?: string;
  tasks?: SkillTaskV1[];
  verifierBody?: string;
  patchBody?: string;
} = {}): Promise<{ dir: string; set: SkillTaskSetV1 }> {
  const dir = await mkdtemp(join(tmpdir(), 'task-set-'));
  const tasks = opts.tasks ?? [task()];
  for (const t of tasks) {
    await mkdir(join(dir, 'verifiers'), { recursive: true });
    await mkdir(join(dir, 'patches'), { recursive: true });
    for (const vf of t.verifierFiles) {
      await mkdir(join(dir, vf, '..'), { recursive: true });
      await writeFile(join(dir, vf), opts.verifierBody ?? 'def test_size():\n    assert True\n');
    }
    await writeFile(join(dir, t.referencePatchFile), opts.patchBody ?? 'diff --git a/x b/x\n');
  }
  const body = { version: 'skill-task-set.v1' as const, skill: opts.skill ?? 'tdd', domain: 'python', tasks };
  const sha256 = await hashTaskSet(dir, body);
  const set: SkillTaskSetV1 = { ...body, sha256 };
  await writeFile(join(dir, 'set.json'), `${JSON.stringify(set, null, 2)}\n`);
  return { dir, set };
}

describe('validateTaskSet', () => {
  it('accepts a well-formed set', () => {
    const set: SkillTaskSetV1 = { version: 'skill-task-set.v1', skill: 'tdd', domain: 'python', tasks: [task()], sha256: 'x' };
    expect(() => validateTaskSet(set)).not.toThrow();
  });

  it('rejects an empty tasks array', () => {
    const set: SkillTaskSetV1 = { version: 'skill-task-set.v1', skill: 'tdd', domain: 'python', tasks: [], sha256: 'x' };
    expect(() => validateTaskSet(set)).toThrow(/no tasks/);
  });

  it('rejects a task with zero verifierFiles', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
      tasks: [task({ verifierFiles: [] })], sha256: 'x',
    };
    expect(() => validateTaskSet(set)).toThrow(/no verifierFiles/);
  });

  it.each(['background', 'requirement', 'fileOps', 'acceptance'] as const)(
    'rejects a task missing requirement.%s',
    (part) => {
      const set: SkillTaskSetV1 = {
        version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
        tasks: [task({ requirement: requirement({ [part]: '' }) })], sha256: 'x',
      };
      expect(() => validateTaskSet(set)).toThrow(new RegExp(`requirement\\.${part}`));
    },
  );

  it.each(['background', 'requirement', 'fileOps', 'acceptance'] as const)(
    'rejects requirement.%s naming the skill under test',
    (part) => {
      const set: SkillTaskSetV1 = {
        version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
        tasks: [task({ requirement: requirement({ [part]: 'Please use tdd to fix this.' }) })], sha256: 'x',
      };
      expect(() => validateTaskSet(set)).toThrow(/names the skill under test/);
    },
  );

  it('is case-insensitive when matching the skill name', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'TDD', domain: 'python',
      tasks: [task({ requirement: requirement({ background: 'Apply tdd here.' }) })], sha256: 'x',
    };
    expect(() => validateTaskSet(set)).toThrow(/names the skill under test/);
  });

  it('rejects duplicate task ids', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
      tasks: [task(), task()], sha256: 'x',
    };
    expect(() => validateTaskSet(set)).toThrow(/duplicate task id/);
  });
});

describe('hashTaskSet / loadTaskSet round-trip', () => {
  it('load succeeds when the on-disk hash matches', async () => {
    const { dir, set } = await makeFixtureSet();
    const loaded = await loadTaskSet(dir);
    expect(loaded.sha256).toBe(set.sha256);
    expect(loaded.tasks).toHaveLength(1);
  });

  it('is deterministic for identical content', async () => {
    const { dir: dirA, set: setA } = await makeFixtureSet();
    const { set: setB } = await makeFixtureSet();
    expect(setA.sha256).toBe(setB.sha256);
    // sanity: not vacuously equal because both are empty/degenerate
    expect(setA.sha256).toHaveLength(64);
    await loadTaskSet(dirA); // does not throw
  });

  it('invalidates the hash when a verifier file changes on disk', async () => {
    const { dir, set } = await makeFixtureSet();
    await writeFile(join(dir, 'verifiers/test_widget_size.py'), 'def test_size():\n    assert False\n');
    await expect(loadTaskSet(dir)).rejects.toThrow(/sha256 mismatch/);
    // the original hash no longer matches a fresh hash of the tampered dir
    const rehashed = await hashTaskSet(dir, set);
    expect(rehashed).not.toBe(set.sha256);
  });

  it('invalidates the hash when the reference patch changes on disk', async () => {
    const { dir, set } = await makeFixtureSet();
    await writeFile(join(dir, 'patches/fix-widget-0001.patch'), 'diff --git a/y b/y\n');
    const rehashed = await hashTaskSet(dir, set);
    expect(rehashed).not.toBe(set.sha256);
  });

  it('invalidates the hash when set membership changes (task added)', async () => {
    const { dir, set } = await makeFixtureSet();
    const extra = task({ id: 'fix-widget-0002', verifierFiles: ['verifiers/test_widget_size.py'] });
    const rehashed = await hashTaskSet(dir, { ...set, tasks: [...set.tasks, extra] });
    expect(rehashed).not.toBe(set.sha256);
  });

  it('does NOT change when a gradeability receipt is added — receipts are excluded from the hash', async () => {
    const { dir, set } = await makeFixtureSet();
    const withReceipt: SkillTaskSetV1 = {
      ...set,
      tasks: set.tasks.map((t) => ({
        ...t,
        gradeability: { status: 'pass' as const, checkedAt: '2026-07-31T00:00:00.000Z', referenceMs: 1, emptyMs: 1, gradeLogDigest: 'abc' },
      })),
    };
    const rehashed = await hashTaskSet(dir, withReceipt);
    expect(rehashed).toBe(set.sha256);
  });

  it('rejects a missing verifier file with a clear error', async () => {
    const { dir } = await makeFixtureSet();
    const raw = JSON.parse(await readFile(join(dir, 'set.json'), 'utf8')) as SkillTaskSetV1;
    raw.tasks[0]!.verifierFiles = ['verifiers/does-not-exist.py'];
    await writeFile(join(dir, 'set.json'), `${JSON.stringify(raw, null, 2)}\n`);
    await expect(loadTaskSet(dir)).rejects.toThrow(TaskSetValidationError);
  });
});

describe('gradeability gate refusal', () => {
  it('isTaskGradeabilityPassing distinguishes pass from absent/other', () => {
    expect(isTaskGradeabilityPassing(task())).toBe(false);
    expect(isTaskGradeabilityPassing(task({
      gradeability: { status: 'pass', checkedAt: 'x', referenceMs: 1, emptyMs: 1, gradeLogDigest: 'd' },
    }))).toBe(true);
  });

  it('assertTaskSetGradeable passes when every task has a passing receipt', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
      tasks: [task({ gradeability: { status: 'pass', checkedAt: 'x', referenceMs: 1, emptyMs: 1, gradeLogDigest: 'd' } })],
      sha256: 'x',
    };
    expect(() => assertTaskSetGradeable(set)).not.toThrow();
  });

  it('assertTaskSetGradeable refuses the whole set when any task lacks a passing receipt', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
      tasks: [
        task({ id: 'fix-widget-0001', gradeability: { status: 'pass', checkedAt: 'x', referenceMs: 1, emptyMs: 1, gradeLogDigest: 'd' } }),
        task({ id: 'fix-widget-0002' }), // no gradeability
      ],
      sha256: 'x',
    };
    expect(() => assertTaskSetGradeable(set)).toThrow(/fix-widget-0002/);
    expect(() => assertTaskSetGradeable(set)).toThrow(/without a passing gradeability receipt/);
  });
});

describe('assertNoArmNameLeak (I2)', () => {
  it('passes when no arm name appears in any requirement part', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'tdd', domain: 'python',
      tasks: [task()], sha256: 'x',
    };
    expect(() => assertNoArmNameLeak(set, ['baseline', 'tdd-plus'])).not.toThrow();
  });

  it('throws when a non-baseline arm name leaks into requirement text, case-insensitively', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'widget-fixer', domain: 'python',
      tasks: [task({ requirement: requirement({ acceptance: 'Use TDD-Plus to write the failing test first.' }) })],
      sha256: 'x',
    };
    expect(() => assertNoArmNameLeak(set, ['baseline', 'tdd-plus'])).toThrow(/names arm 'tdd-plus'/);
  });

  it('the literal arm name "baseline" is exempt — it is a rig convention, not a skill identity', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'widget-fixer', domain: 'python',
      tasks: [task({ requirement: requirement({ background: 'Compare against the baseline behavior.' }) })],
      sha256: 'x',
    };
    expect(() => assertNoArmNameLeak(set, ['baseline', 'tdd-plus'])).not.toThrow();
  });

  it('checks every task in the set, not just the first', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'widget-fixer', domain: 'python',
      tasks: [
        task({ id: 'fix-widget-0001' }),
        task({ id: 'fix-widget-0002', requirement: requirement({ fileOps: 'Only touch files under src/, per tdd-plus.' }) }),
      ],
      sha256: 'x',
    };
    expect(() => assertNoArmNameLeak(set, ['baseline', 'tdd-plus'])).toThrow(/fix-widget-0002/);
  });

  it('is a no-op when the only arm name given is baseline (or none at all)', () => {
    const set: SkillTaskSetV1 = {
      version: 'skill-task-set.v1', skill: 'widget-fixer', domain: 'python',
      tasks: [task()], sha256: 'x',
    };
    expect(() => assertNoArmNameLeak(set, ['baseline'])).not.toThrow();
    expect(() => assertNoArmNameLeak(set, [])).not.toThrow();
  });
});
