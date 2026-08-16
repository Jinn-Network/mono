// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import {
  ENVIRONMENT_BUILD_RECIPE_V1,
  TASK_ENVIRONMENT_SPEC_V1,
  DigestQualifiedImageV1Schema,
  EnvironmentBuildRecipeV1Schema,
  hashTaskEnvironmentSpecV1,
  parseTaskEnvironmentSpecV1,
  type EnvironmentBuildRecipeV1,
  type InputRightsRefV1,
  type TaskEnvironmentSpecV1,
} from './contracts.js';
import { canonicalJson } from '../../util/canonical-json.js';
import type {
  EnvironmentArtifactUploader,
  EnvironmentAttestor,
  EnvironmentBuilder,
  EnvironmentImagePublisher,
  EnvironmentImageScanner,
  EnvironmentSbomGenerator,
} from './interfaces.js';
import type { GitHubRepositoryChecker } from './github.js';
import {
  DEFAULT_PUBLICATION_RIGHTS_POLICY_VERSION,
  evaluateDefaultRightsPolicy,
  isApprovedImage,
  type ApprovedImage,
  type VerifiedInputPublicationFacts,
} from './policy.js';
import { APPROVED_BASE_IMAGES } from './recipes.js';

export const DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY = 'ghcr.io/jinn-network/task-environment' as const;

export type EnvironmentPublicationControllerDependencies = {
  builder: EnvironmentBuilder;
  scanner: EnvironmentImageScanner;
  sbomGenerator: EnvironmentSbomGenerator;
  publisher: EnvironmentImagePublisher;
  uploader: EnvironmentArtifactUploader;
  attestor: EnvironmentAttestor;
  githubChecker: GitHubRepositoryChecker;
  approvedBaseImages?: readonly ApprovedImage[];
  imageRepository?: string;
  clock?: () => Date;
};

/**
 * The immutable, signed environment artifact together with the CID returned
 * by the final environment-document publication (not recipe or SBOM uploads).
 */
export type PublishedTaskEnvironmentV1 = {
  spec: TaskEnvironmentSpecV1;
  environmentCid: string;
};

/**
 * Orders local build evidence and public disclosure so a failed gate leaves no
 * registry or artifact-store side effect behind.
 */
export class EnvironmentPublicationController {
  private readonly approvedBaseImages: readonly ApprovedImage[];
  private readonly imageRepository: string;
  private readonly clock: () => Date;

  constructor(private readonly dependencies: EnvironmentPublicationControllerDependencies) {
    this.approvedBaseImages = dependencies.approvedBaseImages ?? APPROVED_BASE_IMAGES;
    this.imageRepository = dependencies.imageRepository ?? DEFAULT_ENVIRONMENT_IMAGE_REPOSITORY;
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async publish(rawRecipe: EnvironmentBuildRecipeV1): Promise<PublishedTaskEnvironmentV1> {
    const recipe = EnvironmentBuildRecipeV1Schema.parse(rawRecipe);
    assertSourceBinding(recipe);
    if (!isApprovedImage(recipe.baseImage, this.approvedBaseImages)) {
      throw new Error('environment base image is not approved for publication');
    }

    const verifiedInputs = await this.verifyInputRights(recipe.inputRights);
    const rights = evaluateDefaultRightsPolicy({ inputRights: recipe.inputRights, verifiedInputs });
    if (!rights.allowed) throw new Error(`environment publication rights denied: ${rights.code}`);

    const built = await this.dependencies.builder.build(recipe);
    if (built.platform !== recipe.platform || built.workspace !== recipe.workspace || built.smoke.status !== 'pass') {
      throw new Error('local environment build did not satisfy its immutable recipe');
    }

    const scan = await this.dependencies.scanner.scan(built);
    if (scan.status !== 'pass') throw new Error('environment secret scan failed');
    const sbom = await this.dependencies.sbomGenerator.generate(built);

    const publishedImage = await this.dependencies.publisher.publish({ image: built, repository: this.imageRepository });
    const parsedImage = DigestQualifiedImageV1Schema.parse(publishedImage);
    const image = {
      reference: parsedImage.reference,
      digest: parsedImage.digest as `sha256:${string}`,
    };
    assertPublishedImageRepository(image, this.imageRepository);

    const recipeUpload = await this.dependencies.uploader.upload({ kind: 'recipe', document: recipe });
    const sbomUpload = await this.dependencies.uploader.upload({ kind: 'sbom', document: sbom.document });
    const unsigned = this.unsignedSpec(recipe, image, recipeUpload.cid, sbomUpload.cid);
    const attestation = await this.dependencies.attestor.attest({ environmentHash: hashTaskEnvironmentSpecV1(unsigned) });
    const spec = parseTaskEnvironmentSpecV1({ ...unsigned, attestation });
    const environmentUpload = await this.dependencies.uploader.upload({ kind: 'environment', document: spec });
    if (!environmentUpload.cid.trim()) throw new Error('environment publication returned no environment CID');
    return { spec, environmentCid: environmentUpload.cid };
  }

  private async verifyInputRights(inputRights: readonly InputRightsRefV1[]): Promise<Record<string, VerifiedInputPublicationFacts>> {
    const verifiedInputs: Record<string, VerifiedInputPublicationFacts> = {};
    for (const rights of inputRights) {
      const input = parseGitHubInputRef(rights.inputRef);
      const facts = await this.dependencies.githubChecker.check(input);
      if (facts.inputRef !== rights.inputRef) {
        throw new Error(`GitHub evidence did not bind the declared input: ${rights.inputRef}`);
      }
      verifiedInputs[rights.inputRef] = facts;
    }
    return verifiedInputs;
  }

  private unsignedSpec(
    recipe: EnvironmentBuildRecipeV1,
    image: { reference: string; digest: `sha256:${string}` },
    recipeCid: string,
    sbomCid: string,
  ): TaskEnvironmentSpecV1 {
    return {
      schemaVersion: TASK_ENVIRONMENT_SPEC_V1,
      source: recipe.source,
      inputs: recipe.inputRights.map((rights) => ({
        inputRef: rights.inputRef,
        sha256: sha256Canonical({ inputRef: rights.inputRef, rights }),
        rights,
      })),
      execution: {
        platform: recipe.platform,
        workspace: recipe.workspace,
        image,
        testCommands: recipe.testCommands,
        parser: recipe.parser,
        timeoutSeconds: recipe.timeoutSeconds,
        environment: recipe.environment,
      },
      build: {
        recipeCid,
        recipeHash: sha256Canonical({ schemaVersion: ENVIRONMENT_BUILD_RECIPE_V1, recipe }),
        provider: 'explicit',
        providerId: recipe.recipeId,
        providerVersion: 'v1',
      },
      publication: {
        publicRepoVerifiedAt: this.clock().toISOString(),
        rightsPolicyVersion: DEFAULT_PUBLICATION_RIGHTS_POLICY_VERSION,
        buildSmoke: 'pass',
        imageSecretScan: 'pass',
        sbomCid,
      },
      attestation: {
        scheme: 'eip191',
        algo: 'secp256k1',
        environmentHash: sha256Canonical({ provisional: 'attestation-not-signed' }),
        operatorSafe: '0x0000000000000000000000000000000000000000',
        signer: '0x0000000000000000000000000000000000000000',
        signature: `0x${'0'.repeat(130)}`,
      },
    };
  }
}

function assertSourceBinding(recipe: EnvironmentBuildRecipeV1): void {
  const canonicalRepoUrl = `https://github.com/${recipe.source.repo}.git`;
  if (recipe.source.repoUrl !== canonicalRepoUrl) {
    throw new Error('environment source.repoUrl must equal the canonical GitHub URL for source.repo');
  }
  const sourceInputRef = `git+${recipe.source.repoUrl}#${recipe.source.baseCommit}`;
  if (!recipe.inputRights.some((rights) => rights.inputRef === sourceInputRef)) {
    throw new Error('environment recipe requires an exact source input-rights record');
  }
}

function parseGitHubInputRef(inputRef: string): { repo: string; baseCommit: string } {
  const match = /^git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\.git#([0-9a-f]{40})$/.exec(inputRef);
  if (!match) throw new Error(`publication requires a GitHub input pinned to a full commit: ${inputRef}`);
  return { repo: match[1]!, baseCommit: match[2]! };
}

function assertPublishedImageRepository(
  image: { reference: string; digest: `sha256:${string}` },
  imageRepository: string,
): void {
  const prefix = `${imageRepository}/`;
  const digestOffset = image.reference.lastIndexOf('@');
  if (!image.reference.startsWith(prefix) || digestOffset <= prefix.length) {
    throw new Error('image publisher must return an image in the requested image repository');
  }
}

function sha256Canonical(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}
