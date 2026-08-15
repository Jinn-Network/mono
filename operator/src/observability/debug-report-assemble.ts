/**
 * Pure debug-report bundle assembler (issue #420 §2).
 *
 * Takes already-gathered inputs (status snapshot, resolved config, config
 * provenance, recent activity events, log files, optional screenshot) and
 * produces a redacted `.tar.gz` support bundle. Pure — no I/O, no Store, no
 * HTTP — so it is fully unit-testable. The HTTP endpoint
 * (`api/debug-report-endpoint.ts`) gathers the inputs and calls this.
 *
 * Every JSON file is run through `redactValue` before serialization; log
 * files are already redacted on disk by `FileLogger`, but are re-redacted
 * here defensively (idempotent). The result is safe to share.
 */

import { redactValue, buildRedactionReport, REDACTION_VERSION } from './redact-secrets.js';
import { writeTarGz, type TarFile } from './tar.js';

export interface DebugReportInput {
  /** Daemon status snapshot (`gatherStatusForApi` output). */
  status: unknown;
  /** Resolved effective `JinnConfig`. */
  config: unknown;
  /** Config provenance (`buildConfigProvenance` output — already secret-free). */
  configProvenance: unknown;
  /** Recent lifecycle activity events. */
  activityEvents: unknown;
  /** Log files copied from `FileLogger.listLogFiles()` (name + bytes). */
  logFiles: Array<{ name: string; content: Buffer }>;
  /** Daemon build version, from `build-info.ts`. */
  daemonVersion: string;
  /** Optional dashboard screenshot PNG bytes. */
  screenshotPng?: Buffer;
  /** Override the generation timestamp (deterministic tests). */
  generatedAt?: string;
}

/** The set of files a debug-report bundle always contains (relative names). */
export const DEBUG_REPORT_FILES = [
  'status.json',
  'config.json',
  'config-provenance.json',
  'activity-events.json',
  'redaction-report.md',
  'bundle-meta.json',
] as const;

function jsonFile(name: string, value: unknown): TarFile {
  return {
    name,
    content: Buffer.from(`${JSON.stringify(redactValue(value), null, 2)}\n`, 'utf8'),
  };
}

/** Filesystem-safe ISO timestamp for the bundle directory / filename. */
export function bundleStamp(generatedAt: string): string {
  return generatedAt.replace(/[:.]/g, '-');
}

/**
 * Assemble a redacted `.tar.gz` debug-report bundle. Returns the gzip buffer.
 * Async because the gzip pass is offloaded to the libuv pool (see `writeTarGz`).
 */
export async function assembleDebugReport(input: DebugReportInput): Promise<Buffer> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const root = `jinn-debug-report-${bundleStamp(generatedAt)}`;
  const at = (rel: string): string => `${root}/${rel}`;

  const files: TarFile[] = [
    jsonFile(at('status.json'), input.status),
    jsonFile(at('config.json'), input.config),
    jsonFile(at('config-provenance.json'), input.configProvenance),
    jsonFile(at('activity-events.json'), input.activityEvents),
    {
      name: at('redaction-report.md'),
      content: Buffer.from(buildRedactionReport(), 'utf8'),
    },
    jsonFile(at('bundle-meta.json'), {
      schemaVersion: 1,
      generatedAt,
      daemonVersion: input.daemonVersion,
      redactionVersion: REDACTION_VERSION,
    }),
  ];

  // Log files — re-redact defensively (FileLogger already redacts on write).
  for (const log of input.logFiles) {
    files.push({
      name: at(`logs/${log.name}`),
      content: Buffer.from(redactValue(log.content.toString('utf8')) as string, 'utf8'),
    });
  }

  // Screenshot — included verbatim when present, else a clear note.
  if (input.screenshotPng && input.screenshotPng.length > 0) {
    files.push({ name: at('dashboard-screenshot.png'), content: input.screenshotPng });
  } else {
    files.push({
      name: at('screenshot-unavailable.txt'),
      content: Buffer.from(
        'No dashboard screenshot was captured. The operator browser either '
          + 'declined to capture the DOM (content-security policy, very large '
          + 'page) or the bundle was generated without a browser.\n',
        'utf8',
      ),
    });
  }

  return await writeTarGz(files);
}
