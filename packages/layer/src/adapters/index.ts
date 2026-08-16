/**
 * Harness-layer → plugin-port adapter shims (#1660, Stage 1).
 *
 * Each `createXAdapter(deps)` factory returns an object that `implements` the
 * matching `@jinn-network/plugin` port and passes that port's
 * `describeXPortContract` from `@jinn-network/plugin/testing`. Every method
 * converts internal throws into a typed `PortResult` (`ok`/`degraded`/
 * `unavailable`) so an adapter never crashes across the port boundary.
 *
 * The dependency arrow is one-way: harness-layer imports the ports/schemas
 * FROM `@jinn-network/plugin`; the plugin package never imports `operator/**`.
 */
export { createCorpusAdapter } from './corpus-adapter.js';
export { episodeToCorpusRecord, type EpisodeRecordProjection } from './episode-record.js';
export {
  createLocalEpisodeCorpusAdapter,
  localEpisodeRef,
  LOCAL_EPISODE_REF_PREFIX,
  type LocalEpisodeCorpusAdapterDeps,
} from './local-episode-corpus-adapter.js';
export {
  createFederatedCorpusAdapter,
  DEFAULT_FEDERATED_CHILD_TIMEOUT_MS,
  type FederatedCorpusAdapterDeps,
} from './federated-corpus-adapter.js';
export { createEvidenceAdapter, capturedTaskToEpisode } from '@jinn-network/core';
export {
  createContributionAdapter,
  createContributionStatusStore,
  type ContributionStatusStore,
} from './contribution-adapter.js';
export { createLocalLearningAdapter } from './local-learning-adapter.js';
export { createSkillsAdapter } from './skills-adapter.js';
