// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in Docker Desktop regression coverage for the Buildx archive boundary.
 *
 * Run with:
 *   JINN_TEST_DOCKER_ARCHIVE_EXPORT=1 yarn vitest run test/task-creator/environment/archive-export.integration.test.ts
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { DockerBuildxEnvironmentBuilder } from '../../../src/task-creator/environment/adapters.js';
import { JINN_MONO_RECIPE_V1, resolveJinnMonoRecipeV1 } from '../../../src/task-creator/environment/recipes.js';

const execFileAsync = promisify(execFile);
const enabled = process.env['JINN_TEST_DOCKER_ARCHIVE_EXPORT'] === '1';

describe.skipIf(!enabled)('Docker Buildx archive export (integration)', () => {
  it('exports, loads, and inspects a linux/amd64 image through the archive path', async () => {
    const tag = `jinn-environment/archive-export-test:${process.pid}-${Date.now()}`;
    const builder = new DockerBuildxEnvironmentBuilder({
      localImageTag: () => tag,
      temporaryContexts: {
        async create() {
          const path = await mkdtemp(join(tmpdir(), 'jinn-archive-export-fixture-'));
          return {
            path,
            // The builder still receives a strict public-repo recipe. This
            // integration fixture replaces its rendered Dockerfile solely to
            // keep the Docker Desktop regression fast and source-free.
            async writeFile(name) {
              if (name !== 'Dockerfile') throw new Error('unexpected build-context file');
              await writeFile(join(path, name), [
                `FROM --platform=linux/amd64 ${JINN_MONO_RECIPE_V1.baseImage.reference}`,
                'RUN printf archive-export-fixture > /archive-export-fixture.txt',
                '',
              ].join('\n'), 'utf8');
            },
            async dispose() {
              await rm(path, { recursive: true, force: true });
            },
          };
        },
      },
    });

    try {
      const image = await builder.build(resolveJinnMonoRecipeV1('a'.repeat(40)));
      expect(image).toMatchObject({
        localImageTag: tag,
        platform: 'linux/amd64',
      });
      expect(image.localImageId).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await execFileAsync('docker', ['image', 'rm', '--force', tag]).catch(() => undefined);
    }
  }, 180_000);
});
