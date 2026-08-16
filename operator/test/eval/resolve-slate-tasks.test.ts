import { describe, expect, it, vi } from 'vitest';
import { resolveSlateTasks } from '@/eval/resolve-slate-tasks.js';
import type { HfFetcher, HfRow } from '@/harnesses/impls/swe-rebench-v2-evaluator/index.js';
import type { SweRebenchV2Task } from '@jinn-network/sdk/solvernets/swe-rebench-v2';

function stubRow(instance_id: string): HfRow {
  return {
    instance_id,
    repo: 'org/repo',
    image_name: `img-${instance_id}`,
    FAIL_TO_PASS: ['t1'],
    PASS_TO_PASS: ['t2'],
    test_patch: 'diff',
    install_config: { test_cmd: 'pytest', log_parser: 'pytest' },
  };
}

function poolTask(instance_id: string, over: Partial<SweRebenchV2Task> = {}): SweRebenchV2Task {
  return {
    schemaVersion: 'swe-rebench-v2.v1',
    instance_id,
    repo: 'org/repo',
    base_commit: 'a'.repeat(40),
    language: 'go',
    problem_statement: `fix ${instance_id}`,
    interface: `iface ${instance_id}`,
    hf_dataset: 'nebius/SWE-rebench',
    hf_split: '2026_02',
    deadline_unix: 12345,
    round_month: '2026-02',
    ...over,
  };
}

describe('resolveSlateTasks', () => {
  it('resolves each pool task to a {task,row} pair, sorted by instance_id, carrying real fields', async () => {
    const fetcher: HfFetcher = {
      fetchTaskRow: vi.fn(async ({ instance_id }) => stubRow(instance_id)),
    };
    const out = await resolveSlateTasks({
      poolTasks: [
        poolTask('zzz__b-2', { base_commit: 'b'.repeat(40), problem_statement: 'solve b' }),
        poolTask('aaa__a-1', { base_commit: 'c'.repeat(40), problem_statement: 'solve a' }),
      ],
      hf_dataset: 'nebius/SWE-rebench',
      hf_split: '2026_02',
      fetcher,
    });

    expect(out.map((o) => o.task.instance_id)).toEqual(['aaa__a-1', 'zzz__b-2']);
    // H1: the real problem_statement + base_commit are carried through from the
    // pool task (the agent run needs them), not stamped placeholders.
    const a = out.find((o) => o.task.instance_id === 'aaa__a-1')!.task;
    expect(a.problem_statement).toBe('solve a');
    expect(a.base_commit).toBe('c'.repeat(40));
    expect(a.language).toBe('go');
    expect(a.round_month).toBe('2026-02');
    for (const { task, row } of out) {
      expect(task.hf_dataset).toBe('nebius/SWE-rebench');
      expect(task.hf_split).toBe('2026_02');
      expect(task.interface).toBe(`iface ${task.instance_id}`);
      expect(row.instance_id).toBe(task.instance_id);
    }
    expect(fetcher.fetchTaskRow).toHaveBeenCalledTimes(2);
  });

  it('propagates a fetcher throw loudly (no silent drop)', async () => {
    const fetcher: HfFetcher = {
      fetchTaskRow: vi.fn(async ({ instance_id }) => {
        if (instance_id === 'bad__x-1') throw new Error('404 missing');
        return stubRow(instance_id);
      }),
    };
    await expect(
      resolveSlateTasks({
        poolTasks: [poolTask('ok__a-1'), poolTask('bad__x-1')],
        hf_dataset: 'nebius/SWE-rebench',
        hf_split: '2026_02',
        fetcher,
      }),
    ).rejects.toThrow('404 missing');
  });
});
