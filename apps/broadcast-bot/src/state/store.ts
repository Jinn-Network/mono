import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const POSTED_CAP = 1_000;

export interface SourceState<T> {
  watermark: T | null;
  posted: string[];
}

export interface BotState {
  github: {
    releases: SourceState<string>;
    prs: SourceState<string>;
    discussions: SourceState<string>;
  };
  onchain: SourceState<number>;
}

function emptySource<T>(): SourceState<T> {
  return { watermark: null, posted: [] };
}

export function emptyState(): BotState {
  return {
    github: {
      releases: emptySource<string>(),
      prs: emptySource<string>(),
      discussions: emptySource<string>(),
    },
    onchain: emptySource<number>(),
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid broadcast bot state: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function normalizeSource<T extends string | number>(
  value: unknown,
  label: string,
  watermarkType: 'string' | 'number',
): SourceState<T> {
  if (value === undefined) return emptySource<T>();

  const source = asRecord(value, label);
  const watermark = source.watermark ?? null;
  if (
    watermark !== null &&
    (typeof watermark !== watermarkType ||
      (watermarkType === 'number' &&
        (!Number.isSafeInteger(watermark) || (watermark as number) < 0)))
  ) {
    throw new Error(`Invalid broadcast bot state: ${label}.watermark has the wrong type`);
  }
  if (!Array.isArray(source.posted) || !source.posted.every((key) => typeof key === 'string')) {
    throw new Error(`Invalid broadcast bot state: ${label}.posted must be a string array`);
  }

  return {
    watermark: watermark as T | null,
    posted: source.posted.slice(-POSTED_CAP),
  };
}

function normalizeState(value: unknown): BotState {
  const root = asRecord(value, 'root');
  const github = root.github === undefined ? {} : asRecord(root.github, 'github');

  return {
    github: {
      releases: normalizeSource<string>(github.releases, 'github.releases', 'string'),
      prs: normalizeSource<string>(github.prs, 'github.prs', 'string'),
      discussions: normalizeSource<string>(github.discussions, 'github.discussions', 'string'),
    },
    onchain: normalizeSource<number>(root.onchain, 'onchain', 'number'),
  };
}

export class StateStore {
  constructor(private readonly path: string) {}

  load(): BotState {
    if (!existsSync(this.path)) return emptyState();
    return normalizeState(JSON.parse(readFileSync(this.path, 'utf8')) as unknown);
  }

  save(state: BotState): void {
    const normalized = normalizeState(state);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  }
}
