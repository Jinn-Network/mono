import { describe, it, expect } from 'vitest';
import { SweRebenchV2TaskSchema } from '../src/swe-rebench-v2.js';

const validTask = {
  schemaVersion: 'swe-rebench-v2.v1',
  instance_id: 'unidata__netcdf-c-1925',
  repo: 'Unidata/netcdf-c',
  base_commit: 'ad6bff35c39a0600fb8f2e176be4269e768e4e22',
  language: 'c',
  problem_statement: 'tst_filter does not handle quoted filter args correctly...',
  interface: 'Function: handle_filter(args)\nReturns: int',
  hf_dataset: 'nebius/SWE-rebench-leaderboard',
  hf_split: '2026_02',
  deadline_unix: 1746547200,
  round_month: '2026-05',
};

describe('SweRebenchV2TaskSchema', () => {
  it('parses a valid task', () => {
    expect(() => SweRebenchV2TaskSchema.parse(validTask)).not.toThrow();
  });

  it('requires instance_id', () => {
    const bad = { ...validTask, instance_id: undefined };
    expect(() => SweRebenchV2TaskSchema.parse(bad)).toThrow();
  });

  it('requires hf_split (the monthly partition identifier)', () => {
    const bad = { ...validTask, hf_split: undefined };
    expect(() => SweRebenchV2TaskSchema.parse(bad)).toThrow();
  });

  it('accepts known languages: python, javascript, typescript, go, c, cpp, cs, java, rust, dart', () => {
    for (const language of ['python', 'javascript', 'typescript', 'go', 'c', 'cpp', 'cs', 'java', 'rust', 'dart']) {
      expect(() => SweRebenchV2TaskSchema.parse({ ...validTask, language })).not.toThrow();
    }
  });

  it('allows interface to be empty string (some tasks have no auxiliary interface)', () => {
    expect(() => SweRebenchV2TaskSchema.parse({ ...validTask, interface: '' })).not.toThrow();
  });

  it('allows immutable minted-pool IPFS row routing without broad URL routing', () => {
    expect(() => SweRebenchV2TaskSchema.parse({
      ...validTask,
      hf_dataset: 'ipfs://bafymintedpool',
      hf_split: 'minted',
    })).not.toThrow();
    expect(() => SweRebenchV2TaskSchema.parse({ ...validTask, hf_dataset: 'https://example.test/rows' })).toThrow();
  });

  it('requires the IPFS/minted and HuggingFace/monthly transport pairs', () => {
    expect(() => SweRebenchV2TaskSchema.parse({
      ...validTask,
      hf_dataset: 'ipfs://bafymintedpool',
      hf_split: '2026_07',
    })).toThrow();
    expect(() => SweRebenchV2TaskSchema.parse({
      ...validTask,
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: 'minted',
    })).toThrow();
  });
});
