import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { argv, env, pid } from 'node:process';
import {
  buildGitHubLifecycleSnapshot,
  explainIssue,
  explainPullRequest,
  GhLifecycleReader,
  parseLifecycleCli,
  renderLifecycleHuman,
  renderLifecycleJson,
  runLifecycleCycle,
} from '../src/lifecycle/index.js';

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const STALE_AFTER_MS = 2 * 60 * 60_000;

function authorAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
}

async function main(): Promise<void> {
  const options = parseLifecycleCli(argv.slice(2));
  const reader = new GhLifecycleReader();
  const runnerId = env.JINN_AUTOPILOT_RUNNER_ID ?? `${hostname()}:${pid}`;
  const readSnapshot = () => buildGitHubLifecycleSnapshot(reader, {
    authorAllowlist: authorAllowlist(env.JINN_DISPATCHER_AUTHOR_ALLOWLIST),
  });

  const runOnce = async (): Promise<void> => {
    const report = await runLifecycleCycle(options.mode, {
      readSnapshot,
      now: () => new Date(),
      staleAfterMs: STALE_AFTER_MS,
      runnerId,
      cycleId: randomUUID,
    });
    if (options.json) {
      process.stdout.write(`${renderLifecycleJson(report)}\n`);
    } else if (options.command.kind === 'explain-issue') {
      process.stdout.write(`${explainIssue(report, options.command.number)}\n`);
    } else if (options.command.kind === 'explain-pr') {
      process.stdout.write(`${explainPullRequest(report, options.command.number)}\n`);
    } else {
      process.stdout.write(`${renderLifecycleHuman(report)}\n`);
    }
    if (report.status === 'rejected') process.exitCode = 2;
  };

  await runOnce();
  while (!options.once && process.exitCode !== 2) {
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
    await runOnce();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[autopilot:v2] ${message}`);
  process.exitCode = 1;
});
