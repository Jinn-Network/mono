/**
 * One-click operator debug-report endpoints (issue #420 §2).
 *
 * `GET /v1/debug-report/manifest` — describes what the bundle will contain
 *   (file list + redaction summary) so the SPA can show the operator before
 *   they download. No screenshot needed.
 *
 * `POST /v1/debug-report` — gathers the daemon status, resolved config,
 *   config provenance, recent activity events and rotated log files,
 *   assembles a redacted `.tar.gz`, and streams it as an attachment. The
 *   request body may carry a client-captured dashboard screenshot.
 *
 * Both routes are gated by the UI token via the `app.use('/v1/debug-report*')`
 * block in `startApiServer`. They register eagerly (no holder needed — the
 * Store and config are available at server-start time).
 */

import type { Hono } from 'hono';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { Store } from '../store/store.js';
import type { JinnConfig } from '../config.js';
import { buildConfigProvenance } from '../config.js';
import { gatherStatusForApi } from './gather-status.js';
import { buildInfo } from '../build-info.js';
import { getFileLogger } from '../observability/file-logger.js';
import {
  assembleDebugReport,
  DEBUG_REPORT_FILES,
} from '../observability/debug-report-assemble.js';
import { REDACTION_VERSION } from '../observability/redact-secrets.js';

/** Number of recent lifecycle events to include in the bundle. */
const ACTIVITY_EVENT_LIMIT = 1000;

export interface DebugReportRoutesConfig {
  store: Store;
  /** The live resolved config object held by `main.ts`. */
  config: JinnConfig;
  /** Explicit config path passed to `loadConfig`, if any. */
  configPath?: string;
}

/** Decode a base64 dashboard screenshot from the request body. */
function decodeScreenshot(value: unknown): Buffer | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  // Tolerate a `data:image/png;base64,` prefix even though the SPA strips it.
  const stripped = value.replace(/^data:image\/png;base64,/, '');
  try {
    const buf = Buffer.from(stripped, 'base64');
    return buf.length > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/** The rotated log files' on-disk paths, in bundle order. Never throws. */
function logFilePaths(): string[] {
  try {
    return getFileLogger().listLogFiles();
  } catch {
    return [];
  }
}

/**
 * Read the rotated log files for the bundle. Best-effort — never throws.
 * Async (`fs/promises.readFile`) so reading up to ~25 MiB of rotated logs
 * does not block the daemon event loop on the request path.
 */
async function readLogFiles(): Promise<Array<{ name: string; content: Buffer }>> {
  const out: Array<{ name: string; content: Buffer }> = [];
  for (const path of logFilePaths()) {
    try {
      out.push({ name: basename(path), content: await readFile(path) });
    } catch {
      // Skip an unreadable log file rather than failing the whole bundle.
    }
  }
  return out;
}

export function addDebugReportRoutes(app: Hono, config: DebugReportRoutesConfig): void {
  // GET /v1/debug-report/manifest — describe the bundle before download.
  app.get('/v1/debug-report/manifest', (c) => {
    const logNames = logFilePaths().map((p) => `logs/${basename(p)}`);
    return c.json({
      files: [...DEBUG_REPORT_FILES, ...logNames, 'dashboard-screenshot.png'],
      redaction: {
        version: REDACTION_VERSION,
        redacted: [
          'keystore password / JINN_PASSWORD',
          'private keys, mnemonics and seed phrases',
          'daemon API token, UI token, handshake key',
          'harness / provider API keys',
          'RPC URL credential segments',
        ],
        kept: [
          'wallet addresses (public on-chain)',
          'RPC hostnames and path shape (needed to reproduce network issues)',
          'contract and deployment addresses',
          'file paths',
        ],
        notRedacted: [
          'dashboard-screenshot.png — a pixel capture of the screen; text '
            + 'redaction does not apply, so anything visible at capture time '
            + 'appears in it. Review before sharing.',
        ],
      },
    });
  });

  // POST /v1/debug-report — assemble and stream the redacted .tar.gz.
  app.post('/v1/debug-report', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json<Record<string, unknown>>();
    } catch {
      // Empty / missing body is allowed — the screenshot is optional.
    }

    const screenshotPng = decodeScreenshot(body['screenshotPngBase64']);

    let status: unknown;
    try {
      status = await gatherStatusForApi(config.store, undefined);
    } catch (err) {
      status = {
        error: 'status_gather_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let configProvenance: unknown;
    try {
      configProvenance = buildConfigProvenance(config.configPath, config.config);
    } catch (err) {
      configProvenance = {
        error: 'provenance_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let activityEvents: unknown;
    try {
      activityEvents = config.store.getRecentActivityEvents(ACTIVITY_EVENT_LIMIT);
    } catch (err) {
      activityEvents = {
        error: 'activity_events_failed',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const generatedAt = new Date().toISOString();
    const bundle = await assembleDebugReport({
      status,
      config: config.config,
      configProvenance,
      activityEvents,
      logFiles: await readLogFiles(),
      daemonVersion: buildInfo.implVersion,
      screenshotPng,
      generatedAt,
    });

    const filename = `jinn-debug-report-${generatedAt.slice(0, 10)}.tar.gz`;
    return new Response(new Uint8Array(bundle), {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${filename}"`,
        'content-length': String(bundle.length),
      },
    });
  });
}
