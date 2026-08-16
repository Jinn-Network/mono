// SPDX-License-Identifier: Apache-2.0

import type {
  CommandSpec,
  Eip191EnvironmentAttestationV1,
  EnvironmentBuildRecipeV1,
} from './contracts.js';
export type { GitHubRepositoryChecker } from './github.js';

/** The local-only result of a successful isolated image construction. */
export type BuiltEnvironment = {
  localImageTag: string;
  /** Docker's immutable local image identifier when the engine reports one. */
  localImageId?: `sha256:${string}`;
  /** A local repository digest when available before registry publication. */
  localImageDigest?: `sha256:${string}`;
  platform: 'linux/amd64';
  workspace: '/testbed';
  smoke: {
    status: 'pass';
    commands: readonly CommandSpec[];
  };
};

export type EnvironmentScanReport = {
  status: 'pass' | 'fail';
  /** A local Trivy-compatible document. It is not a published CID. */
  report: unknown;
};

export type EnvironmentSbomDocument = {
  /** A local Syft-compatible document. It is not a published CID. */
  document: unknown;
};

export type PublishedEnvironmentImage = {
  /** Must be a digest-qualified remote image reference. */
  reference: string;
  digest: `sha256:${string}`;
};

export interface EnvironmentImageScanner {
  scan(input: BuiltEnvironment): Promise<EnvironmentScanReport>;
}

export interface EnvironmentSbomGenerator {
  generate(input: BuiltEnvironment): Promise<EnvironmentSbomDocument>;
}

export interface EnvironmentBuilder {
  build(recipe: EnvironmentBuildRecipeV1): Promise<BuiltEnvironment>;
}

/** Owns registry authentication and docker push outside the build context. */
export interface EnvironmentImagePublisher {
  publish(input: {
    image: BuiltEnvironment;
    repository: string;
  }): Promise<PublishedEnvironmentImage>;
}

/** Artifact storage happens only after local gates and successful image push. */
export interface EnvironmentArtifactUploader {
  upload(input: {
    kind: 'recipe' | 'sbom' | 'environment';
    document: unknown;
  }): Promise<{ cid: string }>;
}

export interface EnvironmentAttestor {
  attest(input: { environmentHash: `sha256:${string}` }): Promise<Eip191EnvironmentAttestationV1>;
}
