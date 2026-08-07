import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  IssueRelayAutomatedEvidenceV1,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import type { SemanticRuntimeReadiness } from './autopilot-semantic.js';
import { runSupervisedProcess } from './supervised-process.js';

const MAX_SCANNER_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface IssueRelaySecurityScannerResult {
  readonly evidence: IssueRelayAutomatedEvidenceV1;
  /** Credential-free scanner output supplied only to the security adjudicator. */
  readonly report: string;
}

export interface IssueRelaySecurityScanner {
  isReady?(): Promise<SemanticRuntimeReadiness>;
  run(input: {
    readonly checkoutPath: string;
    readonly abort: AbortSignal;
  }): Promise<IssueRelaySecurityScannerResult>;
}

export interface SnykIssueRelaySecurityScannerOptions {
  snykPath?: string;
  environment?: NodeJS.ProcessEnv;
  makeTempDir?: () => Promise<string>;
  remove?: (path: string) => Promise<void>;
  runProcess?: typeof runSupervisedProcess;
}

function snykEnvironment(
  isolatedHome: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, 'xdg-config'),
    XDG_DATA_HOME: join(isolatedHome, 'xdg-data'),
    XDG_CACHE_HOME: join(isolatedHome, 'xdg-cache'),
  };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SNYK_TOKEN'] as const) {
    const value = environment[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Optional deterministic Snyk Code input. Its token is never passed to Claude. */
export class SnykIssueRelaySecurityScanner implements IssueRelaySecurityScanner {
  private readonly snykPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly makeTempDir: () => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;
  private readonly runProcess: typeof runSupervisedProcess;

  constructor(options: SnykIssueRelaySecurityScannerOptions = {}) {
    this.snykPath = options.snykPath ?? 'snyk';
    this.environment = options.environment ?? process.env;
    this.makeTempDir = options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-relay-snyk-')));
    this.remove = options.remove ?? ((path) => rm(path, { recursive: true, force: true }));
    this.runProcess = options.runProcess ?? runSupervisedProcess;
  }

  async isReady(): Promise<SemanticRuntimeReadiness> {
    if (!this.environment['SNYK_TOKEN']) {
      return { ready: false, reason: 'Relay Snyk scanning requires SNYK_TOKEN' };
    }
    const isolatedHome = await this.makeTempDir();
    try {
      const result = await this.runProcess(this.snykPath, ['--version'], {
        env: snykEnvironment(isolatedHome, this.environment),
        maxOutputBytes: 64 * 1024,
      });
      return result.stdout.trim().length === 0
        ? { ready: false, reason: 'Relay Snyk scanner returned no version' }
        : { ready: true };
    } catch (error) {
      return {
        ready: false,
        reason: `Relay Snyk scanner is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    } finally {
      try { await this.remove(isolatedHome); } catch { /* negative readiness only */ }
    }
  }

  async run(input: {
    readonly checkoutPath: string;
    readonly abort: AbortSignal;
  }): Promise<IssueRelaySecurityScannerResult> {
    if (!this.environment['SNYK_TOKEN']) {
      throw new Error('Relay Snyk scanning requires SNYK_TOKEN');
    }
    const isolatedHome = await this.makeTempDir();
    try {
      const env = snykEnvironment(isolatedHome, this.environment);
      const version = (await this.runProcess(this.snykPath, ['--version'], {
        env,
        abort: input.abort,
        maxOutputBytes: 64 * 1024,
      })).stdout.trim();
      if (version.length === 0) throw new Error('Snyk returned no version');
      const result = await this.runProcess(
        this.snykPath,
        ['code', 'test', '--json', '--severity-threshold=low'],
        {
          cwd: input.checkoutPath,
          env,
          abort: input.abort,
          maxOutputBytes: MAX_SCANNER_OUTPUT_BYTES,
          acceptedExitCodes: [1],
        },
      );
      JSON.parse(result.stdout);
      const status = result.exitCode === 0 ? 'passed' as const : 'findings' as const;
      const digest = `sha256:${createHash('sha256').update(result.stdout).digest('hex')}` as const;
      return {
        evidence: {
          tool: 'snyk-code',
          version,
          status,
          digest,
          summary: status === 'passed'
            ? 'Snyk Code completed without findings.'
            : 'Snyk Code completed with findings supplied to the security adjudicator.',
        },
        report: result.stdout,
      };
    } finally {
      try { await this.remove(isolatedHome); } catch { /* scanner result remains authoritative */ }
    }
  }
}

export function snykIssueRelayScannerFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): IssueRelaySecurityScanner | undefined {
  return environment['JINN_ISSUE_RELAY_SNYK_ENABLED'] === '1'
    ? new SnykIssueRelaySecurityScanner({ environment })
    : undefined;
}
