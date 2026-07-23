import {
  createJinnPlugin,
  type CorpusPort,
  type EvidencePort,
  type JinnPlugin,
  type JinnPluginDeps,
} from '@jinn-network/plugin';
import {
  createContributionAdapter,
  createCorpusAdapter,
  createEvidenceAdapter,
  createFederatedCorpusAdapter,
  createLocalLearningAdapter,
  createLocalEpisodeCorpusAdapter,
  createSkillsAdapter,
} from './adapters/index.js';
import {
  ContributionStore,
  defaultEvidenceIndexPath,
  reindexEvidenceStore,
  resolveContributionStateDir,
} from '@jinn-network/core';
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

/** Compose the private local evidence corpus with the default public corpus. */
export function composeDefaultCorpus(
  evidence: EvidencePort,
  publicCorpus: CorpusPort,
): CorpusPort {
  return createFederatedCorpusAdapter({
    local: createLocalEpisodeCorpusAdapter({ evidence }),
    public: publicCorpus,
  });
}

/** Assemble the real port set used by versioned process hosts. */
export function buildPluginDepsFromEnv(overrides: Partial<JinnPluginDeps> = {}): JinnPluginDeps {
  const evidenceDir = episodesDir();
  const evidenceIndexPath = process.env['JINN_LAYER_EVIDENCE_INDEX_PATH']
    ?? defaultEvidenceIndexPath(evidenceDir);
  let refreshIndex = Promise.resolve();
  const evidence = overrides.evidence ?? createEvidenceAdapter({
    capturesDir: evidenceDir,
    onStoreChanged: () => {
      const refresh = () => {
        const report = reindexEvidenceStore({
          episodesDir: evidenceDir,
          indexPath: evidenceIndexPath,
        });
        if (!report.indexUpdated) {
          throw new Error(report.indexError ?? 'derived evidence index was not updated');
        }
      };
      refreshIndex = refreshIndex.then(refresh, refresh);
      return refreshIndex;
    },
  });
  const corpus = overrides.corpus ?? (() => {
    const publicCorpus = createCorpusAdapter({ layer: buildDefaultLayer() });
    return composeDefaultCorpus(evidence, publicCorpus);
  })();
  const contribution = overrides.contribution ?? createContributionAdapter({
    statusStore: new ContributionStore({ stateDir: resolveContributionStateDir() }),
    evidence,
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
