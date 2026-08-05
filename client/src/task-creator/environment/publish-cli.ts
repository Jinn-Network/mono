// SPDX-License-Identifier: Apache-2.0

import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { basename, dirname, resolve } from 'node:path';
import { z } from 'zod/v3';
import {
  Eip191EnvironmentAttestationV1Schema,
  EnvironmentBuildRecipeV1Schema,
  parseTaskEnvironmentSpecV1,
  verifyEnvironmentAttestationV1,
  type Eip191EnvironmentAttestationV1,
  type EnvironmentBuildRecipeV1,
} from './contracts.js';
import { canonicalJson } from '../../util/canonical-json.js';
import {
  DockerBuildxEnvironmentBuilder,
  DockerImagePublisher,
  IpfsEnvironmentArtifactUploader,
  Syft131SpdxSbomGenerator,
  Trivy066SecretScanner,
  defaultEnvironmentCommandRunner,
  type EnvironmentCommandRunner,
} from './adapters.js';
import { createGitHubRepoPublicationChecker, type GitHubFetch } from './github.js';
import type { EnvironmentAttestor } from './interfaces.js';
import {
  EnvironmentPublicationController,
  DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY,
  type EnvironmentPublicationControllerDependencies,
  type PublishedTaskEnvironmentV1,
} from './publication.js';

const EXECUTE_ENVIRONMENT_VARIABLE = 'JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE' as const;
const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be an Ethereum address');

const EnvironmentPublicationCliConfigSchema = z.object({
  recipe: EnvironmentBuildRecipeV1Schema,
  ipfsRegistryUrl: z.string().url(),
  operatorSafe: AddressSchema,
  signer: z.object({
    command: z.string().min(1).refine(isAbsolute, 'must be an absolute path'),
  }).strict(),
  imageRepository: z.string().min(1).optional(),
}).strict();

export type EnvironmentPublicationCliConfig = z.infer<typeof EnvironmentPublicationCliConfigSchema>;

export type EnvironmentPublicationCliResult =
  | {
    mode: 'preflight';
    recipeId: string;
    source: { repo: string; baseCommit: string };
  }
  | {
    mode: 'published';
    environmentCid: string;
    environmentHash: `sha256:${string}`;
    imageReference: string;
  };

type PublicationControllerPort = {
  publish(recipe: EnvironmentBuildRecipeV1): Promise<PublishedTaskEnvironmentV1>;
};

export type EnvironmentPublicationCliDependencies = {
  commandRunner?: EnvironmentCommandRunner;
  githubFetch?: GitHubFetch;
  controllerFactory?: (dependencies: EnvironmentPublicationControllerDependencies) => PublicationControllerPort;
};

export type RunEnvironmentPublicationCliInput = EnvironmentPublicationCliDependencies & {
  rawConfig: unknown;
  environment?: NodeJS.ProcessEnv;
  /** Local path for the exact canonical signed environment artifact. Execute mode only. */
  outputPath?: string;
};

/**
 * Validates an operator-supplied publication config. This object intentionally
 * has no credential, private-key, Docker-config, or token field.
 */
export function parseEnvironmentPublicationCliConfig(input: unknown): EnvironmentPublicationCliConfig {
  assertNoSecretBearingConfigFields(input);
  const config = EnvironmentPublicationCliConfigSchema.parse(input);
  assertPublicRegistryUrl(config.ipfsRegistryUrl);
  if (config.imageRepository !== undefined && /\s|@/.test(config.imageRepository)) {
    throw new Error('imageRepository must be an OCI repository without credentials');
  }
  return config;
}

/**
 * Preflight is the default and makes no Docker, network, IPFS, signer, or
 * registry calls. Execution requires the exact explicit opt-in environment.
 */
export async function runEnvironmentPublicationCli(input: RunEnvironmentPublicationCliInput): Promise<EnvironmentPublicationCliResult> {
  const config = parseEnvironmentPublicationCliConfig(input.rawConfig);
  if (input.environment?.[EXECUTE_ENVIRONMENT_VARIABLE] !== '1') {
    if (input.outputPath !== undefined) {
      throw new Error('--output requires execute mode (set JINN_TASK_CREATOR_ENVIRONMENT_PUBLISH_EXECUTE=1)');
    }
    return {
      mode: 'preflight',
      recipeId: config.recipe.recipeId,
      source: { repo: config.recipe.source.repo, baseCommit: config.recipe.source.baseCommit },
    };
  }

  const commandRunner = input.commandRunner ?? defaultEnvironmentCommandRunner;
  const dependencies: EnvironmentPublicationControllerDependencies = {
    builder: new DockerBuildxEnvironmentBuilder({ commandRunner }),
    scanner: new Trivy066SecretScanner({ commandRunner }),
    sbomGenerator: new Syft131SpdxSbomGenerator({ commandRunner }),
    publisher: new DockerImagePublisher({ commandRunner }),
    uploader: new IpfsEnvironmentArtifactUploader({ registryUrl: config.ipfsRegistryUrl }),
    attestor: new ExternalCommandEnvironmentAttestor({ command: config.signer.command, commandRunner, operatorSafe: config.operatorSafe }),
    githubChecker: createGitHubRepoPublicationChecker({ fetchImpl: input.githubFetch ?? defaultGitHubFetch }),
    imageRepository: config.imageRepository ?? DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY,
  };
  const controller = input.controllerFactory?.(dependencies) ?? new EnvironmentPublicationController(dependencies);
  const published = await controller.publish(config.recipe);
  const spec = parseTaskEnvironmentSpecV1(published.spec);
  const canonicalSpec = canonicalJson(spec);
  if (input.outputPath !== undefined) {
    await atomicWriteCanonicalEnvironmentSpec(input.outputPath, canonicalSpec);
  }
  return {
    mode: 'published',
    environmentCid: published.environmentCid,
    environmentHash: spec.attestation.environmentHash as `sha256:${string}`,
    imageReference: spec.execution.image.reference,
  };
}

/** Write an exactly canonical, structurally valid signed artifact without a partial target file. */
async function atomicWriteCanonicalEnvironmentSpec(outputPath: string, contents: string): Promise<void> {
  if (!outputPath.trim()) throw new Error('--output must name a non-empty path');
  const target = resolve(outputPath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  const written = await readFile(target, 'utf8');
  if (written !== contents) throw new Error('environment publication atomic output did not preserve canonical signed spec bytes');
  const parsed = parseTaskEnvironmentSpecV1(JSON.parse(written));
  if (canonicalJson(parsed) !== contents) {
    throw new Error('environment publication atomic output is not a canonical signed spec');
  }
}

export type ExternalCommandEnvironmentAttestorOptions = {
  command: string;
  operatorSafe: string;
  commandRunner?: EnvironmentCommandRunner;
};

/**
 * Delegates signing to an operator-provided absolute executable. The protocol
 * passes exactly one argument (the SHA-256 environment hash) and expects an
 * EIP-191 attestation JSON object on stdout; no private key is read or passed.
 */
export class ExternalCommandEnvironmentAttestor implements EnvironmentAttestor {
  private readonly commandRunner: EnvironmentCommandRunner;

  constructor(private readonly options: ExternalCommandEnvironmentAttestorOptions) {
    if (!isAbsolute(options.command)) throw new Error('external signer command must be an absolute path');
    this.commandRunner = options.commandRunner ?? defaultEnvironmentCommandRunner;
  }

  async attest(input: { environmentHash: `sha256:${string}` }): Promise<Eip191EnvironmentAttestationV1> {
    const result = await this.commandRunner(this.options.command, [input.environmentHash], {
      env: externalSignerEnvironment(),
    });
    if (result.exitCode !== 0) {
      throw new Error(`external signer command failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new Error('external signer command did not return JSON attestation');
    }
    const attestation = Eip191EnvironmentAttestationV1Schema.parse(raw);
    if (attestation.environmentHash !== input.environmentHash) {
      throw new Error('external signer attestation does not bind the requested environment hash');
    }
    if (attestation.operatorSafe.toLowerCase() !== this.options.operatorSafe.toLowerCase()) {
      throw new Error('external signer attestation operatorSafe does not match configured operatorSafe');
    }
    if (!await verifyEnvironmentAttestationV1(attestation)) {
      throw new Error('external signer returned an invalid environment attestation');
    }
    return attestation;
  }
}

const defaultGitHubFetch: GitHubFetch = async (url, init) => {
  const response = await fetch(url, { headers: init?.headers });
  return {
    ok: response.ok,
    status: response.status,
    async json() { return response.json(); },
  };
};

function assertPublicRegistryUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error('ipfsRegistryUrl must be a credential-free HTTPS URL');
  }
}

function assertNoSecretBearingConfigFields(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretBearingConfigFields(entry, [...path, String(index)]));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (isSecretBearingKey(key)) {
      throw new Error(`secret-bearing config field is not accepted: ${[...path, key].join('.')}`);
    }
    assertNoSecretBearingConfigFields(entry, [...path, key]);
  }
}

function isSecretBearingKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    normalized.includes('privatekey') || normalized.includes('credential') ||
    normalized.includes('creds') || normalized === 'dockerconfig' ||
    normalized === 'dockerauthconfig' || normalized.includes('token') ||
    normalized.includes('apikey') || normalized.includes('password') ||
    normalized.includes('secret') || normalized === 'accesskey' ||
    normalized.endsWith('accesskeyid')
  );
}

function externalSignerEnvironment(): NodeJS.ProcessEnv {
  return process.env.PATH === undefined ? {} : { PATH: process.env.PATH };
}
