import { argv, env } from 'node:process';
import { isAbsolute } from 'node:path';
import {
  defaultRunner,
} from '../src/dispatcher/issue-source.js';
import {
  AUTOPILOT_V2_REMOTE,
} from '../src/lifecycle/active-runtime-production.js';
import {
  runCapabilityProbe,
  writeCapabilityAttestation,
  type CapabilityProbeGitRunner,
} from '../src/lifecycle/capability-probe.js';
import {
  gitPublicationArgs,
  resolveCredentialPool,
  selectCredential,
} from '../src/lifecycle/credentials.js';
import { withSelectedCredential } from '../src/lifecycle/production-auth.js';

function outputPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--output' || args[1] === undefined) {
    throw new Error(
      'usage: yarn autopilot:capability-probe --output /absolute/path.json',
    );
  }
  if (!isAbsolute(args[1])) {
    throw new Error('Capability attestation output path must be absolute');
  }
  return args[1];
}

async function main(): Promise<void> {
  const output = outputPath(argv.slice(2));
  const repositoryPath = (await defaultRunner('git', [
    'rev-parse',
    '--path-format=absolute',
    '--show-toplevel',
  ])).trim();
  const credentials = await resolveCredentialPool({
    JINN_IMPL_GH_TOKEN: env.JINN_IMPL_GH_TOKEN,
    JINN_REVIEW_GH_TOKEN: env.JINN_REVIEW_GH_TOKEN,
    JINN_REVIEW_BOT_LOGIN: env.JINN_REVIEW_BOT_LOGIN,
  }, defaultRunner);
  const selection = selectCredential(credentials, { phase: 'implement' });
  if (selection.status !== 'selected') throw new Error(selection.detail);
  const attestation = await withSelectedCredential(
    selection.credential,
    env,
    ({ askpass, run }) => {
      const runGit: CapabilityProbeGitRunner = (_command, args) => run('git', [
        ...gitPublicationArgs(askpass, []),
        ...args,
      ]);
      return runCapabilityProbe({
        repositoryPath,
        remoteName: AUTOPILOT_V2_REMOTE,
        implementerLogin: selection.login,
        runGit,
      });
    },
    defaultRunner,
  );
  writeCapabilityAttestation(output, attestation);
  process.stdout.write(`${JSON.stringify({
    status: 'verified',
    attestation: output,
    expiresAt: attestation.expiresAt,
    implementerLogin: attestation.implementerLogin,
  })}\n`);
}

main().catch((error: unknown) => {
  console.error(
    `[autopilot:v2:capability-probe] ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
