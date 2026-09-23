import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  missingPortalManifestCopies,
  missingWatchPatterns,
  portalEntries,
  reachablePortalEdges,
} from '../../../test-support/dockerfile-portals/portal-closure.mjs';

const EDGES = [{ name: '@x/lib', consumer: 'app', target: 'lib' }];

const GOOD = [
  'FROM node:22-slim AS build',
  'COPY lib/package.json ./lib/',
  'COPY app/package.json app/yarn.lock ./app/',
  'RUN corepack enable && yarn install --immutable',
  'FROM node:22-slim',
  'COPY --from=build /app ./',
].join('\n');

describe('shared portal-closure walk', () => {
  it('gives resolutions precedence over the dependency fields', () => {
    const portals = portalEntries({
      dependencies: { '@x/lib': 'portal:../declared' },
      devDependencies: { '@x/lib': 'portal:../from-dev' },
      optionalDependencies: { '@x/lib': 'portal:../from-optional' },
      resolutions: { '@x/lib': 'portal:../resolved' },
    });
    expect(portals.get('@x/lib')).toBe('../resolved');
  });

  it('walks the resolutions target when a dependency field names a different one', () => {
    const context = mkdtempSync(join(tmpdir(), 'portal-closure-'));
    const write = (dir: string, manifest: object) => {
      mkdirSync(join(context, dir), { recursive: true });
      writeFileSync(join(context, dir, 'package.json'), JSON.stringify(manifest));
    };
    write('app', {
      dependencies: { '@x/lib': 'portal:../declared' },
      resolutions: { '@x/lib': 'portal:../resolved' },
    });
    write('declared', {});
    write('resolved', { resolutions: { '@x/deep': 'portal:../deep' } });
    write('deep', {});

    expect(reachablePortalEdges(join(context, 'app'), context)).toEqual([
      { name: '@x/lib', consumer: 'app', target: 'resolved' },
      { name: '@x/deep', consumer: 'resolved', target: 'deep' },
    ]);
  });

  it('accepts a manifest copied before the install in the same stage', () => {
    expect(missingPortalManifestCopies(GOOD, EDGES)).toEqual([]);
  });

  it('names a portal whose manifest is never copied', () => {
    const dockerfile = GOOD.replace('COPY lib/package.json ./lib/\n', '');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
  });

  it('names a portal whose manifest is copied after the install', () => {
    const dockerfile = GOOD.replace('COPY lib/package.json ./lib/\n', '').replace(
      'yarn install --immutable\n',
      'yarn install --immutable\nCOPY lib/package.json ./lib/\n',
    );
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
  });

  it('names a portal whose manifest is copied in another build stage', () => {
    const dockerfile = [
      'FROM node:22-slim AS portals',
      'COPY lib/package.json ./lib/',
      GOOD.replace('COPY lib/package.json ./lib/\n', ''),
    ].join('\n');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
  });

  it('does not count a COPY --from as a build-context copy', () => {
    const dockerfile = GOOD.replace(
      'COPY lib/package.json ./lib/',
      'COPY --from=portals lib/package.json ./lib/',
    );
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
  });

  it('checks the stage that installs a consumer copied in more than one stage', () => {
    const dockerfile = ['FROM node:22-slim AS manifests', 'COPY app/package.json ./app/', GOOD].join('\n');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([]);
  });

  it('names a portal missing from any one stage that installs the consumer', () => {
    const second = ['FROM node:22-slim AS other', 'COPY app/package.json ./app/', 'RUN yarn install'];
    const dockerfile = [GOOD, ...second].join('\n');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
    expect(missingPortalManifestCopies([...second, GOOD].join('\n'), EDGES)).toEqual([
      "@x/lib (lib): not copied before app's install in its build stage",
    ]);
  });

  it('names a consumer whose manifest is never copied', () => {
    const dockerfile = GOOD.replace('COPY app/package.json app/yarn.lock ./app/', 'COPY app/yarn.lock ./app/');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      'app/package.json is never copied',
    ]);
  });

  it('names a consumer whose manifest COPY no install follows', () => {
    const dockerfile = GOOD.replace('RUN corepack enable && yarn install --immutable', 'RUN true');
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([
      'app: no yarn install follows a COPY of its manifest',
    ]);
  });

  it('keeps a continued instruction whole across a comment line', () => {
    const dockerfile = GOOD.replace(
      'COPY lib/package.json ./lib/',
      'COPY \\\n  # portal manifest\n  lib/package.json ./lib/',
    );
    expect(missingPortalManifestCopies(dockerfile, EDGES)).toEqual([]);
  });

  it('names a missing watchPatterns entry', () => {
    const railway = 'watchPatterns = [\n  "packages/app/**",\n]\n';
    expect(missingWatchPatterns(railway, ['app', 'lib'], 'packages/')).toEqual([
      'packages/lib/**',
    ]);
  });
});
