import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeEventsById } from './events-merge';

test('SSE backfill of the same SQLite ids does not duplicate rows', () => {
  const recent = [
    { id: '1', time: 't1' },
    { id: '2', time: 't2' },
    { id: '3', time: 't3' },
    { id: '4', time: 't4' },
  ];
  const sse = [
    { id: '4', time: 't4' },
    { id: '3', time: 't3' },
    { id: '2', time: 't2' },
    { id: '1', time: 't1' },
  ];
  const merged = mergeEventsById(recent, sse);
  assert.deepEqual(
    merged.map((event) => event.id),
    ['4', '3', '2', '1'],
  );
});

test('a new SSE event prepends without dropping existing distinct ids', () => {
  const existing = [{ id: '1' }, { id: '2' }];
  const incoming = [{ id: '3' }, { id: '2' }];
  assert.deepEqual(
    mergeEventsById(existing, incoming).map((event) => event.id),
    ['3', '2', '1'],
  );
});

test('merge caps at 200', () => {
  const existing = Array.from({ length: 180 }, (_, i) => ({ id: String(i) }));
  const incoming = Array.from({ length: 50 }, (_, i) => ({ id: `n${i}` }));
  assert.equal(mergeEventsById(existing, incoming).length, 200);
});
