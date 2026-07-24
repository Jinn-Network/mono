/**
 * Compatibility export while the canonical skill-artifact contract lives in
 * the independently published domain core.
 */
export {
  SKILL_ARTIFACT_TYPE,
  SkillArtifactV1Schema,
  SkillProvenanceSchema,
  SkillCompanionFileSchema,
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_DECODED_BYTES,
  type SkillArtifactV1,
  type SkillProvenance,
  type SkillCompanionFile,
} from '@jinn-network/core';
