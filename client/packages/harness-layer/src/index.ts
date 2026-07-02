/**
 * @jinn-network/harness-layer — embeddable harness-layer surface.
 *
 * v0 exposes the corpus consume path only (search/get). Capture / publish
 * paths are later plan tasks.
 */

export {
  createHarnessLayer,
  DEFAULT_IPFS_GATEWAY_URL,
  type HarnessLayer,
  type HarnessLayerConfig,
  type ResolvedHarnessLayerConfig,
  type CorpusSearchHit,
  type CorpusRecord,
  type CorpusArtifact,
} from './consume.js';
