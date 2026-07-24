#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const layerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(layerRoot, '../..');
const tempRoot = mkdtempSync(join(tmpdir(), 'jinn-layer-pack-smoke-'));
const tarballsDir = join(tempRoot, 'tarballs');
const runtimeDir = join(tempRoot, 'plugin', 'runtime');
const stateDir = join(tempRoot, 'state');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (status ${result.status ?? 'spawn-error'}):\n`
        + [
          result.error?.message,
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
        ].filter(Boolean).join('\n'),
    );
  }
  return result;
}

function pack(relativePackageRoot) {
  const packageRoot = resolve(repoRoot, relativePackageRoot);
  const result = run(
    'npm',
    ['pack', '--silent', '--pack-destination', tarballsDir],
    { cwd: packageRoot },
  );
  const filename = result.stdout.trim();
  if (!filename || filename.includes('\n')) {
    throw new Error(`npm pack returned an invalid filename: ${result.stdout}`);
  }
  return join(tarballsDir, filename);
}

function invokeLayer(args, input) {
  const bin = join(runtimeDir, 'node_modules', '.bin', 'jinn-layer');
  return run(bin, args, {
    cwd: runtimeDir,
    input,
    env: {
      ...process.env,
      HOME: stateDir,
      JINN_LAYER_EPISODES_DIR: join(stateDir, 'episodes'),
      JINN_MINEABLE_STATE_DIR: join(stateDir, 'contribution'),
      JINN_LAYER_SKILLS_INSTALL_DIR: join(stateDir, 'skills'),
      JINN_LAYER_EVIDENCE_INDEX_PATH: join(stateDir, 'evidence.sqlite'),
      NO_COLOR: '1',
    },
  });
}

try {
  for (const directory of [tarballsDir, runtimeDir, stateDir]) {
    mkdirSync(directory, { recursive: true });
  }
  const pluginTarball = pack('packages/plugin');
  const coreTarball = pack('packages/core');
  const layerTarball = pack('packages/layer');

  run('npm', ['init', '--yes'], { cwd: runtimeDir });
  run(
    'npm',
    [
      'install',
      '--loglevel=error',
      pluginTarball,
      coreTarball,
      layerTarball,
    ],
    { cwd: runtimeDir },
  );

  const contract = JSON.parse(
    invokeLayer(['contract', '--json']).stdout.trim(),
  );
  if (
    contract.contractVersion !== 1
    || Object.keys(contract).length !== 1
  ) {
    throw new Error(`unexpected contract payload: ${JSON.stringify(contract)}`);
  }

  const installedServer = join(
    runtimeDir,
    'node_modules',
    '@jinn-network',
    'jinn-layer',
    'dist',
    'distill-mcp-server.js',
  );
  const installedCli = join(
    runtimeDir,
    'node_modules',
    '@jinn-network',
    'jinn-layer',
    'dist',
    'bin',
    'jinn-layer.js',
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
        import { EventEmitter } from 'node:events';
        import { runLocalDistill } from ${JSON.stringify(pathToFileURL(installedServer).href)};

        class FakeChild extends EventEmitter {
          stdout = new EventEmitter();
          stderr = new EventEmitter();
        }

        const child = new FakeChild();
        let spawned;
        const result = runLocalDistill(
          { capturesDir: '/captures', out: '/out' },
          {
            env: { PATH: '', JINN_LAYER_BIN: ${JSON.stringify('C:\\untrusted\\jinn-layer.cmd')} },
            platform: 'win32',
            spawn(command, args) {
              spawned = { command, args };
              queueMicrotask(() => {
                child.stdout.emit('data', '{"distilled":true}\\n');
                child.emit('close', 0);
              });
              return child;
            },
          },
        );
        await result;
        if (spawned?.command !== process.execPath) {
          throw new Error('installed MCP did not invoke Node directly: ' + JSON.stringify(spawned));
        }
        if (spawned?.args?.[0] !== ${JSON.stringify(realpathSync(installedCli))}) {
          throw new Error('installed MCP did not resolve its co-installed CLI: ' + JSON.stringify(spawned));
        }
      `,
    ],
    {
      cwd: runtimeDir,
      env: { ...process.env, PATH: '' },
    },
  );

  const pickup = JSON.parse(
    invokeLayer(
      ['session', 'pickup'],
      JSON.stringify({
        contractVersion: 1,
        meta: {
          sessionId: 'pack-smoke-pickup',
          taskSummary: 'Rehearse the installed layer contract',
          harness: { name: 'pack-smoke', version: '1' },
          model: 'fixture',
          tools: [],
          pickup: { enabled: false },
        },
        firstMessage: 'No network lookup is required for this rehearsal.',
        excludeCanonicalEpisodeIds: ['episode-already-delivered'],
      }),
    ).stdout.trim(),
  );
  if (pickup.contractVersion !== 1 || pickup.status !== 'ok') {
    throw new Error(`unexpected pickup payload: ${JSON.stringify(pickup)}`);
  }

  const episodeId = 'episode-pack-smoke';
  const end = JSON.parse(
    invokeLayer(
      ['session', 'end'],
      JSON.stringify({
        contractVersion: 1,
        episode: {
          schemaVersion: 'jinn.episode.v1',
          episodeId,
          session: {
            sessionId: 'pack-smoke-session',
            capturedAt: '2026-07-20T00:00:00.000Z',
            kind: 'user',
          },
          origin: { writer: 'pack-smoke', build: '0.1.0' },
          task: {
            summary: 'Rehearse the installed layer session boundary',
            distributionTags: ['pack-smoke'],
          },
          trajectory: [{
            spanId: 'turn-1',
            parentSpanId: null,
            kind: 'jinn.agent_turn',
            name: 'turn:user',
            startTimeUnixNano: '1000000000',
            endTimeUnixNano: '1000000001',
            attributes: { role: 'user', content: 'rehearse' },
            redactedKeys: [],
          }],
          environment: {
            harness: { name: 'pack-smoke', version: '1' },
            model: 'fixture',
            tools: [],
            skillsLoadout: [],
          },
          outcome: {
            status: 'completed',
            verifiabilityTier: 'user-accepted',
          },
          cost: { durationMs: 1 },
          retention: { policy: 'local-private' },
          provenance: 'contributed',
        },
        activity: {
          retrievalFired: false,
          eligibleRefs: [],
          deliveredRefs: [],
          deliveryMode: 'disabled',
          surfacedRefs: [],
          fetchedRefs: [],
          installedSkillRefs: [],
          searchedTerms: [],
          providedRefs: [],
        },
        eligibilityInputs: {},
        contributionVetoed: true,
      }),
    ).stdout.trim(),
  );
  if (end.contractVersion !== 1 || end.status !== 'ok') {
    throw new Error(`unexpected session-end payload: ${JSON.stringify(end)}`);
  }

  const episodePath = join(
    stateDir,
    'episodes',
    `${episodeId}.episode.json`,
  );
  if (!existsSync(episodePath)) {
    throw new Error(`session rehearsal did not persist ${episodePath}`);
  }
  const persisted = JSON.parse(readFileSync(episodePath, 'utf8'));
  if (persisted.episodeId !== episodeId) {
    throw new Error(`unexpected persisted episode: ${JSON.stringify(persisted)}`);
  }

  console.log(
    'layer pack smoke: clean npm install, contract, pickup, and session end ok',
  );
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
