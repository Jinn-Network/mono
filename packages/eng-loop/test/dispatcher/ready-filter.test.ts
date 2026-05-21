import { describe, it, expect } from 'vitest';
import { selectReady } from '../../src/dispatcher/ready-filter.js';
import type { PolledIssue } from '../../src/dispatcher/types.js';

const base: PolledIssue = {
  number: 1, title: 't', shape: 'fix', blockedOn: 'Nothing',
  blockedOnIssue: null, effort: 'Low', priority: 'P2',
  status: 'Todo', onBoard: true,
};

describe('selectReady', () => {
  it('keeps a triage-complete, unblocked, on-board, Todo issue', () => {
    expect(selectReady([base], new Set()).map((i) => i.number)).toEqual([1]);
  });
  it('drops an issue with no Issue Type', () => {
    expect(selectReady([{ ...base, shape: null }], new Set())).toEqual([]);
  });
  it('drops an issue Blocked on Human', () => {
    expect(selectReady([{ ...base, blockedOn: 'Human' }], new Set())).toEqual([]);
  });
  it('drops an issue not on the board', () => {
    expect(selectReady([{ ...base, onBoard: false }], new Set())).toEqual([]);
  });
  it('drops an issue already in flight', () => {
    expect(selectReady([base], new Set([1]))).toEqual([]);
  });
  it('orders by Priority then FIFO by issue number', () => {
    const a = { ...base, number: 5, priority: 'P3' as const };
    const b = { ...base, number: 9, priority: 'P0' as const };
    const c = { ...base, number: 3, priority: 'P3' as const };
    expect(selectReady([a, b, c], new Set()).map((i) => i.number)).toEqual([9, 3, 5]);
  });
});
