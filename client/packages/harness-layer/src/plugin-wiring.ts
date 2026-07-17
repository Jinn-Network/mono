import { createJinnPlugin, type JinnPlugin, type JinnPluginDeps } from '@jinn-network/plugin';
import {
  createContributionAdapter,
  createCorpusAdapter,
  createEvidenceAdapter,
  createLocalLearningAdapter,
  createSkillsAdapter,
} from './adapters/index.js';
import { ContributionStore, resolveContributionStateDir } from './contribution-store.js';
import {
  DEFAULT_EPISODES_DIR,
  DEFAULT_SKILLS_INSTALL_DIR,
  localSkillProvenance,
  stagingDirFor,
} from './distill-captures.js';
import { buildDefaultLayer } from './layer-default.js';

function episodesDir(): string {
  return process.env['JINN_LAYER_EPISODES_DIR'] ?? DEFAULT_EPISODES_DIR;
}

function skillsInstallDir(): string {
  return process.env['JINN_LAYER_SKILLS_INSTALL_DIR'] ?? DEFAULT_SKILLS_INSTALL_DIR;
}

/** Assemble the real port set used by versioned process hosts. */
export function buildPluginDepsFromEnv(overrides: Partial<JinnPluginDeps> = {}): JinnPluginDeps {
  const corpus = overrides.corpus ?? createCorpusAdapter({ layer: buildDefaultLayer() });
  const evidence = overrides.evidence ?? createEvidenceAdapter({ capturesDir: episodesDir() });
  const contribution = overrides.contribution ?? createContributionAdapter({
    statusStore: new ContributionStore({ stateDir: resolveContributionStateDir() }),
  });
  const skills = overrides.skills ?? createSkillsAdapter({ installDir: skillsInstallDir() });
  const localLearning = overrides.localLearning ?? createLocalLearningAdapter({
    distiller: {
      distill: async () => ({
        clusterCount: 0,
        distilled: { published: [], rejected: [], errors: [] },
      }),
    },
    loadCaptures: async () => [],
    listSkills: async () => localSkillProvenance(
      skillsInstallDir(),
      stagingDirFor(skillsInstallDir()),
    ),
  });
  return { corpus, evidence, contribution, localLearning, skills };
}

export function buildPluginFromEnv(overrides: Partial<JinnPluginDeps> = {}): JinnPlugin {
  return createJinnPlugin(buildPluginDepsFromEnv(overrides));
}
