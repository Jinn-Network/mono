import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

const STOP_FILE_ENV = 'WORKER_STOP_FILE';
const MAX_CYCLES_ENV = 'WORKER_MAX_CYCLES';

export function getMaxCycles(): number | undefined {
  const raw = process.env[MAX_CYCLES_ENV];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 1 ? value : undefined;
}

export function getStopFilePath(): string | undefined {
  const raw = process.env[STOP_FILE_ENV];
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

export function requestStop(): boolean {
  const stopFilePath = getStopFilePath();
  if (!stopFilePath) return false;
  try {
    mkdirSync(dirname(stopFilePath), { recursive: true });
    writeFileSync(stopFilePath, new Date().toISOString(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function shouldStop(): boolean {
  const stopFilePath = getStopFilePath();
  if (!stopFilePath) return false;
  return existsSync(stopFilePath);
}

export function clearStopFile(): boolean {
  const stopFilePath = getStopFilePath();
  if (!stopFilePath || !existsSync(stopFilePath)) return false;
  try {
    unlinkSync(stopFilePath);
    return true;
  } catch {
    return false;
  }
}
