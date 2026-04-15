import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export interface SuiteContext {
  suiteId: string;
  ponderCacheDir: string;
  ponderPortBase: number;
  controlPortBase: number;
}

function generateSuiteId(): string {
  return `test-${Date.now()}-${process.pid}-${randomUUID().slice(0, 4)}`;
}

export async function withSuiteEnv<T>(fn: (ctx: SuiteContext) => Promise<T>): Promise<T> {
  const prev = {
    suiteId: process.env.E2E_SUITE_ID,
    ponderDir: process.env.PONDER_DATABASE_DIR,
    ponderPortBase: process.env.PONDER_PORT_BASE,
    controlPortBase: process.env.CONTROL_API_PORT_BASE,
  };

  const suiteId = generateSuiteId();
  const ponderPortBase = 42070 + ((Date.now() + process.pid) % 50);
  const controlPortBase = 4001 + (Date.now() % 100);
  const ponderCacheDir = path.join(process.cwd(), `.ponder-${suiteId}`);

  process.env.E2E_SUITE_ID = suiteId;
  process.env.PONDER_DATABASE_DIR = ponderCacheDir;
  process.env.PONDER_PORT_BASE = String(ponderPortBase);
  process.env.CONTROL_API_PORT_BASE = String(controlPortBase);

  if (fs.existsSync(ponderCacheDir)) {
    fs.rmSync(ponderCacheDir, { recursive: true, force: true });
  }

  const ctx: SuiteContext = {
    suiteId,
    ponderCacheDir,
    ponderPortBase,
    controlPortBase,
  };

  try {
    return await fn(ctx);
  } finally {
    if (fs.existsSync(ponderCacheDir)) {
      fs.rmSync(ponderCacheDir, { recursive: true, force: true });
    }

    if (prev.suiteId === undefined) delete process.env.E2E_SUITE_ID;
    else process.env.E2E_SUITE_ID = prev.suiteId;

    if (prev.ponderDir === undefined) delete process.env.PONDER_DATABASE_DIR;
    else process.env.PONDER_DATABASE_DIR = prev.ponderDir;

    if (prev.ponderPortBase === undefined) delete process.env.PONDER_PORT_BASE;
    else process.env.PONDER_PORT_BASE = prev.ponderPortBase;

    if (prev.controlPortBase === undefined) delete process.env.CONTROL_API_PORT_BASE;
    else process.env.CONTROL_API_PORT_BASE = prev.controlPortBase;
  }
}
