// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadToIpfs } from '../../adapters/mech/ipfs.js';
import {
  Eip191EnvironmentAttestationV1Schema,
  EnvironmentBuildRecipeV1Schema,
  environmentAttestationMessageV1,
  type Eip191EnvironmentAttestationV1,
  type EnvironmentBuildRecipeV1,
} from './contracts.js';
import { renderDockerfile } from './build.js';
import type {
  BuiltEnvironment,
  EnvironmentArtifactUploader,
  EnvironmentAttestor,
  EnvironmentBuilder,
  EnvironmentImagePublisher,
  EnvironmentImageScanner,
  EnvironmentSbomGenerator,
  PublishedEnvironmentImage,
} from './interfaces.js';

export type EnvironmentCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** Structured command seam: no adapter constructs a shell command string. */
export type EnvironmentCommandRunner = (
  bin: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<EnvironmentCommandResult>;

export const defaultEnvironmentCommandRunner: EnvironmentCommandRunner = (bin, args, options) => new Promise((resolve, reject) => {
  const child = spawn(bin, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  child.on('error', reject);
  child.on('close', (code: number | null) => resolve({ exitCode: code ?? 1, stdout, stderr }));
});

export interface TemporaryBuildContext {
  readonly path: string;
  /** The builder intentionally permits only its rendered Dockerfile. */
  writeFile(name: 'Dockerfile', content: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface TemporaryBuildContextFilesystem {
  create(): Promise<TemporaryBuildContext>;
}

export interface IsolatedDockerConfig {
  readonly path: string;
  dispose(): Promise<void>;
}

export interface IsolatedDockerConfigFilesystem {
  create(): Promise<IsolatedDockerConfig>;
}

/**
 * The isolated builder may discover Docker CLI plugins only from these static
 * system locations. It never inherits an operator's Docker config.
 */
const APPROVED_DOCKER_CLI_PLUGIN_DIRECTORIES = [
  '/usr/local/lib/docker/cli-plugins',
  '/usr/local/libexec/docker/cli-plugins',
  '/usr/lib/docker/cli-plugins',
  '/usr/libexec/docker/cli-plugins',
  '/Applications/Docker.app/Contents/Resources/cli-plugins',
] as const;

export const localTemporaryBuildContextFilesystem: TemporaryBuildContextFilesystem = {
  async create(): Promise<TemporaryBuildContext> {
    const path = await mkdtemp(join(tmpdir(), 'jinn-environment-'));
    return {
      path,
      async writeFile(name, content) {
        if (name !== 'Dockerfile') throw new Error('local build context may contain only Dockerfile');
        await writeFile(join(path, name), content, 'utf8');
      },
      async dispose() {
        await rm(path, { recursive: true, force: true });
      },
    };
  },
};

/** A fresh empty config prevents buildx from loading ambient registry helpers. */
export const localIsolatedDockerConfigFilesystem: IsolatedDockerConfigFilesystem = {
  async create(): Promise<IsolatedDockerConfig> {
    const path = await mkdtemp(join(tmpdir(), 'jinn-docker-config-'));
    try {
      await writeFile(join(path, 'config.json'), JSON.stringify({
        cliPluginsExtraDirs: APPROVED_DOCKER_CLI_PLUGIN_DIRECTORIES,
      }), 'utf8');
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
    return {
      path,
      async dispose() {
        await rm(path, { recursive: true, force: true });
      },
    };
  },
};

export interface TemporaryDockerArchive {
  readonly archivePath: string;
  readonly metadataPath: string;
  /** Refuses to load a missing, non-regular, or empty Buildx archive. */
  assertReady(): Promise<void>;
  dispose(): Promise<void>;
}

export interface TemporaryDockerArchiveFilesystem {
  create(): Promise<TemporaryDockerArchive>;
}

export const localTemporaryDockerArchiveFilesystem: TemporaryDockerArchiveFilesystem = {
  async create(): Promise<TemporaryDockerArchive> {
    const path = await mkdtemp(join(tmpdir(), 'jinn-docker-archive-'));
    const archivePath = join(path, 'image.tar');
    const metadataPath = join(path, 'metadata.json');
    return {
      archivePath,
      metadataPath,
      async assertReady() {
        await assertNonEmptyRegularFile(archivePath, 'Docker image archive');
      },
      async dispose() {
        await rm(path, { recursive: true, force: true });
      },
    };
  },
};

export type DockerEndpointResolver = () => Promise<string>;

export type DockerBuildxEnvironmentBuilderOptions = {
  commandRunner?: EnvironmentCommandRunner;
  temporaryContexts?: TemporaryBuildContextFilesystem;
  isolatedDockerConfigs?: IsolatedDockerConfigFilesystem;
  temporaryArchives?: TemporaryDockerArchiveFilesystem;
  resolveDockerEndpoint?: DockerEndpointResolver;
  localImageTag?: (recipe: EnvironmentBuildRecipeV1) => string;
};

/**
 * Builds a local image from a Dockerfile-only context. Source reaches Docker
 * only through the recipe's digest-pinned Git checkout; this adapter never
 * accepts registry credentials, build secrets, patches, or a source directory.
 */
export class DockerBuildxEnvironmentBuilder implements EnvironmentBuilder {
  private readonly commandRunner: EnvironmentCommandRunner;
  private readonly temporaryContexts: TemporaryBuildContextFilesystem;
  private readonly isolatedDockerConfigs: IsolatedDockerConfigFilesystem;
  private readonly temporaryArchives: TemporaryDockerArchiveFilesystem;
  private readonly resolveDockerEndpoint: DockerEndpointResolver;
  private readonly localImageTag: (recipe: EnvironmentBuildRecipeV1) => string;

  constructor(options: DockerBuildxEnvironmentBuilderOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultEnvironmentCommandRunner;
    this.temporaryContexts = options.temporaryContexts ?? localTemporaryBuildContextFilesystem;
    this.isolatedDockerConfigs = options.isolatedDockerConfigs ?? localIsolatedDockerConfigFilesystem;
    this.temporaryArchives = options.temporaryArchives ?? localTemporaryDockerArchiveFilesystem;
    this.resolveDockerEndpoint = options.resolveDockerEndpoint ?? (() => resolveActiveDockerEndpoint(this.commandRunner));
    this.localImageTag = options.localImageTag ?? defaultLocalImageTag;
  }

  async build(rawRecipe: EnvironmentBuildRecipeV1): Promise<BuiltEnvironment> {
    const recipe = EnvironmentBuildRecipeV1Schema.parse(rawRecipe);
    const localImageTag = this.localImageTag(recipe);
    assertLocalImageTag(localImageTag);
    const dockerEndpoint = await this.resolveDockerEndpoint();
    const dockerConfig = await this.isolatedDockerConfigs.create();
    let context: TemporaryBuildContext | undefined;
    let archive: TemporaryDockerArchive | undefined;
    let operationError: unknown;
    const options = { env: isolatedBuildEnvironment(dockerConfig.path, dockerEndpoint) };
    try {
      context = await this.temporaryContexts.create();
      archive = await this.temporaryArchives.create();
      await context.writeFile('Dockerfile', renderDockerfile(recipe));
      await requireSuccess(
        this.commandRunner('docker', [
          'buildx', 'build', '--platform', 'linux/amd64',
          '--output', `type=docker,dest=${archive.archivePath}`,
          '--metadata-file', archive.metadataPath,
          '--tag', localImageTag,
          '--file', join(context.path, 'Dockerfile'), context.path,
        ], options),
        'Docker Buildx build',
      );
      await archive.assertReady();
      const loaded = await requireSuccess(
        this.commandRunner('docker', ['image', 'load', '--input', archive.archivePath], options),
        'Docker image load',
      );
      assertDockerImageLoadMatchesTag(loaded.stdout, localImageTag);
      const inspect = await requireSuccess(
        this.commandRunner('docker', ['image', 'inspect', localImageTag, '--format', '{{json .}}'], options),
        'Docker image inspect',
      );
      return builtEnvironmentFromInspect(inspect.stdout, localImageTag, recipe);
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      const cleanupError = await disposeAllTemporaryResources(context, archive, dockerConfig);
      if (cleanupError) {
        const detail = `temporary Docker build cleanup failed: ${cleanupError.message}`;
        if (operationError !== undefined) {
          throw new Error(`${errorMessage(operationError)}; ${detail}`);
        }
        throw new Error(detail);
      }
    }
  }
}

export type Trivy066SecretScannerOptions = { commandRunner?: EnvironmentCommandRunner };

/** Local Trivy 0.66.0 secret scan; reports never leave this adapter as CIDs. */
export class Trivy066SecretScanner implements EnvironmentImageScanner {
  private readonly commandRunner: EnvironmentCommandRunner;

  constructor(options: Trivy066SecretScannerOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultEnvironmentCommandRunner;
  }

  async scan(image: BuiltEnvironment): Promise<{ status: 'pass' | 'fail'; report: unknown }> {
    const localImageId = await verifyCurrentLocalImageBinding(image, this.commandRunner);
    await requireToolVersion(this.commandRunner, 'trivy', '0.66.0');
    const result = await requireSuccess(
      this.commandRunner('trivy', ['image', '--scanners', 'secret', '--format', 'json', '--quiet', localImageId]),
      'Trivy scan',
    );
    const report = parseJsonObject(result.stdout, 'Trivy JSON report');
    if (!Array.isArray(report.Results)) throw new Error('Trivy JSON report must contain a Results array');
    const foundSecrets = report.Results.some((entry) => {
      if (!isRecord(entry)) throw new Error('Trivy JSON report contains an invalid result');
      if (entry.Secrets === undefined) return false;
      if (!Array.isArray(entry.Secrets)) throw new Error('Trivy JSON report contains invalid Secrets');
      return entry.Secrets.length > 0;
    });
    return { status: foundSecrets ? 'fail' : 'pass', report };
  }
}

export type Syft131SpdxSbomGeneratorOptions = { commandRunner?: EnvironmentCommandRunner };

/** Local Syft 1.31.0 SPDX JSON generation; the caller decides publication. */
export class Syft131SpdxSbomGenerator implements EnvironmentSbomGenerator {
  private readonly commandRunner: EnvironmentCommandRunner;

  constructor(options: Syft131SpdxSbomGeneratorOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultEnvironmentCommandRunner;
  }

  async generate(image: BuiltEnvironment): Promise<{ document: unknown }> {
    const localImageId = await verifyCurrentLocalImageBinding(image, this.commandRunner);
    await requireToolVersion(this.commandRunner, 'syft', '1.31.0');
    const result = await requireSuccess(
      this.commandRunner('syft', ['scan', localImageId, '--output', 'spdx-json']),
      'Syft SPDX generation',
    );
    const document = parseJsonObject(result.stdout, 'Syft SPDX document');
    if (typeof document.spdxVersion !== 'string' || !/^SPDX-\d+\.\d+$/.test(document.spdxVersion)) {
      throw new Error('Syft did not emit an SPDX JSON document');
    }
    return { document };
  }
}

export type DockerImagePublisherOptions = { commandRunner?: EnvironmentCommandRunner };

/**
 * Uses Docker's already-configured credential helper. Authentication never
 * appears in this API, in build arguments, or in the temporary build context.
 */
export class DockerImagePublisher implements EnvironmentImagePublisher {
  private readonly commandRunner: EnvironmentCommandRunner;

  constructor(options: DockerImagePublisherOptions = {}) {
    this.commandRunner = options.commandRunner ?? defaultEnvironmentCommandRunner;
  }

  async publish(input: { image: BuiltEnvironment; repository: string }): Promise<PublishedEnvironmentImage> {
    const localImageId = await verifyCurrentLocalImageBinding(input.image, this.commandRunner);
    const repository = normalizeRepository(input.repository);
    const remoteTag = `${repository}:${imageTagSuffix(input.image)}`;
    await requireSuccess(this.commandRunner('docker', ['tag', localImageId, remoteTag]), 'Docker image tag');
    const pushed = await requireSuccess(this.commandRunner('docker', ['push', remoteTag]), 'Docker image push');
    const digest = digestFromDockerPush(pushed.stdout);
    return { reference: `${repository}@${digest}`, digest };
  }
}

export type IpfsEnvironmentArtifactUploaderOptions = {
  registryUrl: string;
  uploadJson?: (registryUrl: string, document: unknown) => Promise<string>;
};

/** Adapts the existing canonical-JSON IPFS registry upload utility. */
export class IpfsEnvironmentArtifactUploader implements EnvironmentArtifactUploader {
  private readonly uploadJson: (registryUrl: string, document: unknown) => Promise<string>;

  constructor(private readonly options: IpfsEnvironmentArtifactUploaderOptions) {
    if (options.registryUrl.trim() === '') throw new Error('IPFS registry URL is required');
    this.uploadJson = options.uploadJson ?? uploadToIpfs;
  }

  async upload(input: { kind: 'recipe' | 'sbom' | 'environment'; document: unknown }): Promise<{ cid: string }> {
    const cid = await this.uploadJson(this.options.registryUrl, input.document);
    if (typeof cid !== 'string' || cid.trim() === '') throw new Error(`IPFS ${input.kind} upload returned no CID`);
    return { cid };
  }
}

export type Eip191MessageSigner = {
  address: string;
  signMessage(input: { message: string }): Promise<string>;
};

export type Eip191EnvironmentAttestorOptions = {
  operatorSafe: string;
  signer: Eip191MessageSigner;
};

/** EIP-191 adapter over an injected signer; no private-key environment is read. */
export class Eip191EnvironmentAttestor implements EnvironmentAttestor {
  constructor(private readonly options: Eip191EnvironmentAttestorOptions) {}

  async attest(input: { environmentHash: `sha256:${string}` }): Promise<Eip191EnvironmentAttestationV1> {
    if (!/^sha256:[0-9a-f]{64}$/.test(input.environmentHash)) {
      throw new Error('environment hash must be a SHA-256 digest');
    }
    const signature = await this.options.signer.signMessage({
      message: environmentAttestationMessageV1(input.environmentHash),
    });
    return Eip191EnvironmentAttestationV1Schema.parse({
      scheme: 'eip191',
      algo: 'secp256k1',
      environmentHash: input.environmentHash,
      operatorSafe: this.options.operatorSafe,
      signer: this.options.signer.address,
      signature,
    });
  }
}

function defaultLocalImageTag(recipe: EnvironmentBuildRecipeV1): string {
  const recipeId = recipe.recipeId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  return `jinn-environment/${recipeId}:${recipe.source.baseCommit.slice(0, 12)}`;
}

function assertLocalImageTag(tag: string): void {
  if (!/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tag)) {
    throw new Error('invalid local Docker image tag');
  }
}

function builtEnvironmentFromInspect(
  stdout: string,
  localImageTag: string,
  recipe: EnvironmentBuildRecipeV1,
): BuiltEnvironment {
  const inspect = parseJsonObject(stdout, 'Docker image inspect');
  if (inspect.Os !== 'linux' || inspect.Architecture !== 'amd64') {
    throw new Error('Docker image inspect did not confirm linux/amd64');
  }
  if (typeof inspect.Id !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(inspect.Id)) {
    throw new Error('Docker image inspect did not return an immutable image ID');
  }
  const localImageDigest = digestFromRepoDigests(inspect.RepoDigests);
  return {
    localImageTag,
    localImageId: inspect.Id as `sha256:${string}`,
    ...(localImageDigest ? { localImageDigest } : {}),
    platform: 'linux/amd64',
    workspace: '/testbed',
    smoke: { status: 'pass', commands: recipe.smokeCommands },
  };
}

function digestFromRepoDigests(value: unknown): `sha256:${string}` | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Docker image inspect returned invalid RepoDigests');
  for (const entry of value) {
    if (typeof entry !== 'string') throw new Error('Docker image inspect returned invalid RepoDigests');
    const match = /@(sha256:[0-9a-f]{64})$/.exec(entry);
    if (match) return match[1]! as `sha256:${string}`;
  }
  return undefined;
}

async function resolveActiveDockerEndpoint(commandRunner: EnvironmentCommandRunner): Promise<string> {
  const explicitEndpoint = process.env['DOCKER_HOST']?.trim();
  if (explicitEndpoint) return normalizeDockerEndpoint(explicitEndpoint);
  const context = await requireSuccess(
    commandRunner('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']),
    'Docker context inspect',
  );
  const output = context.stdout.trim();
  let endpoint: unknown = output;
  try {
    endpoint = JSON.parse(output);
  } catch {
    // Older Docker CLIs can return a raw formatted scalar.
  }
  if (typeof endpoint !== 'string') throw new Error('Docker context inspect did not return a daemon endpoint');
  return normalizeDockerEndpoint(endpoint);
}

function normalizeDockerEndpoint(value: string): string {
  const endpoint = value.trim();
  if (!/^(?:unix|npipe|tcp|ssh):\/\/[^\s]+$/.test(endpoint)) {
    throw new Error('Docker daemon endpoint is invalid');
  }
  return endpoint;
}

function isolatedBuildEnvironment(dockerConfigPath: string, dockerEndpoint: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    DOCKER_CONFIG: dockerConfigPath,
    HOME: dockerConfigPath,
    DOCKER_HOST: dockerEndpoint,
  };
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function assertDockerImageLoadMatchesTag(stdout: string, expectedTag: string): void {
  const loadedTags = [...stdout.matchAll(/^Loaded image:\s*(.+)\s*$/gm)].map((match) => match[1]!.trim());
  if (loadedTags.length !== 1 || loadedTags[0] !== expectedTag) {
    throw new Error(`Docker image load did not load expected tag ${expectedTag}`);
  }
}

async function assertNonEmptyRegularFile(path: string, description: string): Promise<void> {
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(path);
  } catch {
    throw new Error(`${description} is missing or empty`);
  }
  if (!details.isFile() || details.size === 0) throw new Error(`${description} is missing or empty`);
}

async function disposeAllTemporaryResources(
  context: TemporaryBuildContext | undefined,
  archive: TemporaryDockerArchive | undefined,
  dockerConfig: IsolatedDockerConfig,
): Promise<Error | undefined> {
  const failures: string[] = [];
  for (const [name, resource] of [
    ['build context', context],
    ['image archive', archive],
    ['Docker config', dockerConfig],
  ] as const) {
    if (!resource) continue;
    try {
      await resource.dispose();
    } catch (error) {
      failures.push(`${name}: ${errorMessage(error)}`);
    }
  }
  return failures.length === 0 ? undefined : new Error(failures.join('; '));
}

async function verifyCurrentLocalImageBinding(
  image: BuiltEnvironment,
  commandRunner: EnvironmentCommandRunner,
): Promise<`sha256:${string}`> {
  const localImageId = immutableLocalImageId(image);
  assertBuiltEnvironment(image);
  const inspected = await requireSuccess(
    commandRunner('docker', ['image', 'inspect', image.localImageTag, '--format', '{{json .}}']),
    'Docker image binding inspect',
  );
  const current = parseJsonObject(inspected.stdout, 'Docker image binding inspect');
  if (current.Os !== 'linux' || current.Architecture !== 'amd64') {
    throw new Error('Docker image binding inspect did not confirm linux/amd64');
  }
  if (current.Id !== localImageId) {
    throw new Error('Docker image binding inspect does not match immutable local image ID');
  }
  return localImageId;
}

function immutableLocalImageId(image: BuiltEnvironment): `sha256:${string}` {
  if (!image.localImageId || !/^sha256:[0-9a-f]{64}$/.test(image.localImageId)) {
    throw new Error('local environment requires an immutable local image ID');
  }
  return image.localImageId;
}

function assertBuiltEnvironment(image: BuiltEnvironment): void {
  if (
    image.platform !== 'linux/amd64' || image.workspace !== '/testbed' || image.smoke.status !== 'pass' ||
    image.localImageTag.trim() === ''
  ) {
    throw new Error('local environment image is not a verified linux/amd64 build');
  }
  immutableLocalImageId(image);
}

async function requireToolVersion(
  commandRunner: EnvironmentCommandRunner,
  tool: string,
  expectedVersion: string,
): Promise<void> {
  const version = await requireSuccess(commandRunner(tool, ['--version']), `${tool} version`);
  const pattern = new RegExp(`(?:^|\\s|:)${escapeRegex(expectedVersion)}(?:\\s|$)`);
  if (!pattern.test(version.stdout)) throw new Error(`${tool} must be version ${expectedVersion}`);
}

async function requireSuccess(result: Promise<EnvironmentCommandResult>, operation: string): Promise<EnvironmentCommandResult> {
  let completed: EnvironmentCommandResult;
  try {
    completed = await result;
  } catch (error) {
    throw new Error(`${operation} failed to start: ${errorMessage(error)}`);
  }
  if (completed.exitCode !== 0) {
    throw new Error(`${operation} failed (exit ${completed.exitCode}): ${completed.stderr.trim()}`);
  }
  return completed;
}

function parseJsonObject(stdout: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${description} was not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${description} must be an object`);
  return parsed;
}

function normalizeRepository(repository: string): string {
  const normalized = repository.trim().replace(/\/+$/, '');
  if (normalized === '' || /\s|@/.test(normalized)) throw new Error('invalid target image repository');
  return normalized;
}

function imageTagSuffix(image: BuiltEnvironment): string {
  const digest = image.localImageId ?? image.localImageDigest;
  if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error('Docker publisher requires an immutable local image ID or digest');
  }
  return digest.slice('sha256:'.length, 'sha256:'.length + 12);
}

function digestFromDockerPush(stdout: string): `sha256:${string}` {
  const matches = [...stdout.matchAll(/\bdigest:\s*(sha256:[0-9a-f]{64})\b/g)];
  const digest = matches.at(-1)?.[1];
  if (!digest) throw new Error('Docker image push did not report a digest');
  return digest as `sha256:${string}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
