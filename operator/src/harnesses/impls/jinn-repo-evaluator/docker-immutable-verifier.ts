import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { relative } from 'node:path';
import type {
  ImmutableMechanicalVerification,
  ImmutableMechanicalVerifier,
} from './autopilot-mechanical-runner.js';
import {
  KNOWN_LIVE_EVAL_PACKAGES,
  scopeTestsForChangedFiles,
  type PackageScope,
} from './scope-tests.js';
import {
  runSupervisedProcess,
  SupervisedProcessUnreapedError,
} from './supervised-process.js';

const VERIFICATION_IMAGE =
  'node:22-bookworm@sha256:5647be709086c696ff32edaaf1c70cd26d1da6ab2b39c32f3c7b4c4a31957e37';
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const LOG_LIMIT = 4000;
const CLEANUP_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 3 * 60_000;

export type DockerVerificationCommandResult =
  | { readonly status: 'passed' }
  | { readonly status: 'failed'; readonly detail: string };

export type DockerVerificationRunner = (
  args: readonly string[],
  label: string,
  abort?: AbortSignal,
) => Promise<DockerVerificationCommandResult>;

function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (
    const key of [
      'PATH',
      'HOME',
      'LANG',
      'LC_ALL',
      'TMPDIR',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
    ] as const
  ) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

async function defaultDockerRunner(
  args: readonly string[],
  _label: string,
  abort?: AbortSignal,
): Promise<DockerVerificationCommandResult> {
  try {
    await runSupervisedProcess('docker', [...args], {
      env: dockerEnvironment(),
      maxOutputBytes: MAX_OUTPUT_BYTES,
      ...(abort ? { abort } : {}),
    });
    return { status: 'passed' };
  } catch (error) {
    if (
      error instanceof SupervisedProcessUnreapedError
      || (error as { name?: unknown }).name === 'AbortError'
      || /docker exited with code 12[5-7]\b/.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      throw error;
    }
    return {
      status: 'failed',
      detail: (error instanceof Error ? error.message : String(error))
        .slice(0, LOG_LIMIT),
    };
  }
}

function dockerSandboxArgs(input: {
  readonly name: string;
}): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name', input.name,
    '--label', 'jinn.autopilot.evaluator-verification=true',
    '--network', 'bridge',
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '512',
    '--memory', '8g',
    '--cpus', '4',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=67108864',
    '--tmpfs', '/source:rw,nosuid,nodev,noexec,size=1073741824',
    '--tmpfs', '/workspace:rw,nosuid,nodev,size=6442450944',
    '--env', 'HOME=/workspace/.jinn-home',
    '--env', 'XDG_CACHE_HOME=/workspace/.jinn-home/cache',
    '--env', 'COREPACK_HOME=/workspace/.jinn-corepack',
    '--env', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    '--env', 'YARN_IGNORE_PATH=1',
    '--env', 'YARN_NODE_LINKER=node-modules',
    '--env', 'YARN_ENABLE_SCRIPTS=false',
    '--env', 'CI=1',
    VERIFICATION_IMAGE,
    'sh',
    '-ceu',
    // Independent watchdog: a daemon crash cannot leave this networked
    // tmpfs-backed container alive indefinitely.
    'sleep 7200',
  ];
}

function downstreamScopes(changedFiles: readonly string[]): PackageScope[] {
  const direct = scopeTestsForChangedFiles(
    [...changedFiles],
    KNOWN_LIVE_EVAL_PACKAGES,
  );
  const directByRoot = new Map(
    direct.map((scope) => [scope.pkg.root, scope] as const),
  );
  const affected = new Set<string>();
  const downstream: Readonly<Record<string, readonly string[]>> = {
    'packages/plugin': [
      'packages/plugin',
      'packages/core',
      'packages/layer',
      'client',
    ],
    'packages/core': ['packages/core', 'packages/layer', 'client'],
    'packages/sdk': [
      'packages/sdk',
      'packages/indexer',
      'packages/indexer-enrichment',
      'client',
      'packages/autopilot',
    ],
    'packages/indexer': [
      'packages/indexer',
      'packages/indexer-enrichment',
    ],
    'packages/indexer-enrichment': ['packages/indexer-enrichment'],
    'packages/layer': ['packages/layer', 'client'],
    client: ['client'],
    contracts: ['contracts'],
    'packages/autopilot': ['packages/autopilot'],
    'apps/broadcast-bot': ['apps/broadcast-bot'],
  };
  for (const scope of direct) {
    for (const root of downstream[scope.pkg.root] ?? []) {
      affected.add(root);
    }
  }
  return KNOWN_LIVE_EVAL_PACKAGES
    .filter((pkg) => affected.has(pkg.root))
    .map((pkg) =>
      directByRoot.get(pkg.root) ?? { pkg, candidateTestFiles: [] }
    );
}

function relativeTestPath(root: string, candidate: string): string {
  const path = relative(root, candidate);
  if (
    path.length === 0
    || path === '..'
    || path.startsWith('../')
    || path.includes('\\')
  ) {
    throw new Error(`Scoped evaluator test escaped ${root}: ${candidate}`);
  }
  return path;
}

export function makeDockerImmutableMechanicalVerifier(options: {
  readonly runDocker?: DockerVerificationRunner;
  readonly containerName?: () => string;
  readonly pathExists?: (path: string) => Promise<boolean>;
  readonly readinessTimeoutMs?: number;
} = {}): ImmutableMechanicalVerifier {
  const runDocker = options.runDocker ?? defaultDockerRunner;
  const makeContainerName =
    options.containerName
    ?? (() => `jinn-evaluator-verify-${randomUUID()}`);
  const pathExists =
    options.pathExists
    ?? (async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    });

  return {
    async isReady() {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
      );
      timeout.unref?.();
      try {
        const readiness = await runDocker(
          ['info', '--format', '{{json .ServerVersion}}'],
          'docker-readiness',
          controller.signal,
        );
        if (readiness.status === 'failed') {
          return {
            ready: false,
            reason:
              `Docker immutable verifier unavailable: ${readiness.detail}`,
          };
        }
        const inspected = await runDocker(
          ['image', 'inspect', VERIFICATION_IMAGE],
          'verification-image-inspect',
          controller.signal,
        );
        if (inspected.status === 'failed') {
          const pulled = await runDocker(
            ['pull', VERIFICATION_IMAGE],
            'verification-image-pull',
            controller.signal,
          );
          if (pulled.status === 'failed') {
            return {
              ready: false,
              reason:
                `Docker immutable verifier image unavailable: ${pulled.detail}`,
            };
          }
        }
        const nativeSmoke = [
          'set -eu',
          'test -f /usr/local/include/node/node.h',
          'command -v python3 >/dev/null',
          'command -v make >/dev/null',
          'command -v g++ >/dev/null',
          'mkdir -p /tmp/native-smoke',
          "printf '%s\\n' '{\"targets\":[{\"target_name\":\"smoke\",\"sources\":[\"smoke.cc\"]}]}'"
            + ' > /tmp/native-smoke/binding.gyp',
          "printf '%s\\n' '#include <node.h>'"
            + " 'void Init(v8::Local<v8::Object> exports) {}'"
            + " 'NODE_MODULE(NODE_GYP_MODULE_NAME, Init)'"
            + ' > /tmp/native-smoke/smoke.cc',
          'cd /tmp/native-smoke',
          'npm_config_nodedir=/usr/local'
            + ' node /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'
            + ' rebuild --offline',
          "node -e \"require('/tmp/native-smoke/build/Release/smoke.node')\"",
        ].join('; ');
        const smoke = await runDocker([
          'run',
          '--rm',
          '--network', 'none',
          '--read-only',
          '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges:true',
          '--pids-limit', '64',
          '--memory', '512m',
          '--cpus', '1',
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=134217728',
          VERIFICATION_IMAGE,
          'sh',
          '-ceu',
          nativeSmoke,
        ], 'verification-native-toolchain-smoke', controller.signal);
        if (smoke.status === 'failed') {
          return {
            ready: false,
            reason:
              `Docker immutable verifier toolchain unavailable: ${smoke.detail}`,
          };
        }
        return { ready: true };
      } catch (error) {
        return {
          ready: false,
          reason:
            'Docker immutable verifier unavailable: '
            + (error instanceof Error ? error.message : String(error)),
        };
      } finally {
        clearTimeout(timeout);
      }
    },

    async verify(input): Promise<ImmutableMechanicalVerification> {
      const scopes = downstreamScopes(input.changedFiles);
      if (scopes.length === 0) {
        return {
          kind: 'unscorable',
          detail: 'immutable-verifier-no-supported-scope',
        };
      }
      const container = makeContainerName();
      if (!/^jinn-evaluator-verify-[a-zA-Z0-9_.-]+$/.test(container)) {
        throw new Error('Invalid evaluator verification container name');
      }
      let containerCreated = false;
      let cleanupSafe = true;
      const run = async (
        args: readonly string[],
        label: string,
      ): Promise<DockerVerificationCommandResult> => {
        try {
          return await runDocker(args, label, input.abort);
        } catch (error) {
          if (error instanceof SupervisedProcessUnreapedError) {
            cleanupSafe = false;
          }
          throw error;
        }
      };

      const created = await run(
        dockerSandboxArgs({
          name: container,
        }),
        'sandbox-container-create',
      );
      if (created.status === 'failed') {
        throw new Error(
          `Docker evaluator container creation failed: ${created.detail}`,
        );
      }
      containerCreated = true;
      try {
        const uploaded = await run([
          'cp',
          `${input.checkoutDir}/.`,
          `${container}:/source`,
        ], 'sandbox-source-upload');
        if (uploaded.status === 'failed') {
          throw new Error(
            `Docker evaluator source upload failed: ${uploaded.detail}`,
          );
        }
        const seeded = await run([
          'exec',
          '--workdir', '/workspace',
          container,
          'sh',
          '-ceu',
          "tar -C /source --exclude='.git' --exclude='node_modules'"
            + " --exclude='*/node_modules' --exclude='dist' --exclude='*/dist'"
            + " --exclude='.yarn/cache' --exclude='*/.yarn/cache'"
            + ' -cf - . | tar -C /workspace -xf -',
        ], 'sandbox-source-copy');
        if (seeded.status === 'failed') {
          throw new Error(
            `Docker evaluator snapshot failed: ${seeded.detail}`,
          );
        }

        const requiredRoots = new Set(scopes.map(({ pkg }) => pkg.root));
        if (
          requiredRoots.has('packages/indexer')
          || requiredRoots.has('packages/indexer-enrichment')
          || requiredRoots.has('client')
        ) {
          requiredRoots.add('packages/sdk');
        }
        if (
          requiredRoots.has('packages/core')
          || requiredRoots.has('packages/layer')
          || requiredRoots.has('client')
        ) {
          requiredRoots.add('packages/plugin');
        }
        if (
          requiredRoots.has('packages/layer')
          || requiredRoots.has('client')
        ) {
          requiredRoots.add('packages/core');
        }
        if (requiredRoots.has('client')) {
          requiredRoots.add('packages/layer');
        }
        if (requiredRoots.has('packages/indexer-enrichment')) {
          requiredRoots.add('packages/indexer');
        }
        const installRoots = [
          'packages/sdk',
          'packages/plugin',
          'packages/core',
          'packages/layer',
          'packages/indexer',
          'packages/indexer-enrichment',
          'client',
          'contracts',
          'packages/autopilot',
          'apps/broadcast-bot',
        ].filter((root) => requiredRoots.has(root));
        for (const root of installRoots) {
          const label = `${root}:install`;
          const installed = await run([
            'exec',
            '--workdir', `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'install',
            '--immutable',
            '--mode=skip-build',
          ], label);
          if (installed.status === 'failed') {
            return {
              kind: 'unscorable',
              detail: `${label}: ${installed.detail}`.slice(0, LOG_LIMIT),
            };
          }
        }
        const disconnected = await run(
          ['network', 'disconnect', 'bridge', container],
          'sandbox-network-disconnect',
        );
        if (disconnected.status === 'failed') {
          throw new Error(
            `Docker evaluator network isolation failed: ${disconnected.detail}`,
          );
        }
        for (const root of installRoots.filter((value) =>
          value === 'packages/core'
          || value === 'packages/layer'
          || value === 'client')) {
          const label = `${root}:trusted-native-rebuild`;
          const rebuilt = await run([
            'exec',
            '--env', 'YARN_ENABLE_SCRIPTS=true',
            '--env', 'npm_config_nodedir=/usr/local',
            '--env', 'npm_config_build_from_source=true',
            '--workdir', `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'rebuild',
            'better-sqlite3',
          ], label);
          if (rebuilt.status === 'failed') {
            return {
              kind: 'unscorable',
              detail: `${label}: ${rebuilt.detail}`.slice(0, LOG_LIMIT),
            };
          }
          const loaded = await run([
            'exec',
            '--workdir', `/workspace/${root}`,
            container,
            'node',
            '-e',
            "const Database=require('better-sqlite3');"
              + "const db=new Database(':memory:');"
              + "db.exec('create table smoke(value integer);"
              + "insert into smoke values (1)');"
              + "if(db.prepare('select value from smoke').get().value!==1)"
              + "process.exit(1);db.close()",
          ], `${root}:trusted-native-smoke`);
          if (loaded.status === 'failed') {
            return {
              kind: 'unscorable',
              detail:
                `${root}:trusted-native-smoke: ${loaded.detail}`
                  .slice(0, LOG_LIMIT),
            };
          }
        }
        for (
          const root of [
            'packages/sdk',
            'packages/plugin',
            'packages/core',
            'packages/layer',
          ].filter((value) => installRoots.includes(value))
        ) {
          const label = `${root}:trusted-bootstrap-build`;
          const built = await run([
            'exec',
            '--workdir', `/workspace/${root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            'build',
          ], label);
          if (built.status === 'failed') {
            return {
              kind: 'unscorable',
              detail: `${label}: ${built.detail}`.slice(0, LOG_LIMIT),
            };
          }
        }

        const checks: string[] = [];
        for (const scope of scopes) {
          const typecheckLabel = `${scope.pkg.root}:typecheck`;
          const typechecked = await run([
            'exec',
            '--workdir', `/workspace/${scope.pkg.root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            scope.pkg.typecheckScript,
          ], typecheckLabel);
          if (typechecked.status === 'failed') {
            return {
              kind: 'failed',
              check: typecheckLabel,
              detail: typechecked.detail,
            };
          }
          checks.push(typecheckLabel);

          const existingTests: string[] = [];
          for (const candidate of scope.candidateTestFiles) {
            if (await pathExists(`${input.checkoutDir}/${candidate}`)) {
              existingTests.push(
                relativeTestPath(scope.pkg.root, candidate),
              );
            }
          }
          const testLabel = `${scope.pkg.root}:test`;
          const testArgs = existingTests.length === 0
            ? [scope.pkg.testScript]
            : ['vitest', 'run', ...existingTests];
          const tested = await run([
            'exec',
            '--workdir', `/workspace/${scope.pkg.root}`,
            container,
            'corepack',
            'yarn@4.13.0',
            ...testArgs,
          ], testLabel);
          if (tested.status === 'failed') {
            return {
              kind: 'failed',
              check: testLabel,
              detail: tested.detail,
            };
          }
          checks.push(testLabel);
        }
        return { kind: 'passed', checks };
      } finally {
        if (containerCreated && cleanupSafe) {
          const cleanup = new AbortController();
          const timeout = setTimeout(
            () => cleanup.abort(),
            CLEANUP_TIMEOUT_MS,
          );
          timeout.unref?.();
          try {
            const removed = await runDocker(
              ['rm', '-f', container],
              'sandbox-container-remove',
              cleanup.signal,
            );
            if (removed.status === 'failed') {
              throw new Error(
                `Docker evaluator container cleanup failed: ${removed.detail}`,
              );
            }
          } finally {
            clearTimeout(timeout);
          }
        }
      }
    },
  };
}
