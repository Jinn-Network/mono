// Org/project constants shared across the dispatcher and triage modules.
// Defined once here so the literals are not duplicated per call site.

export const ORG = 'Jinn-Network';
export const REPO = 'Jinn-Network/mono';
// GitHub REST Link headers canonicalize this repository's named path to its
// stable database-id path. Keep the mapping pinned so pagination confinement
// cannot be widened to an arbitrary numeric repository.
export const REPO_REST_DATABASE_ID = 1_190_804_373;
export const PROJECT_NUMBER = 1;
