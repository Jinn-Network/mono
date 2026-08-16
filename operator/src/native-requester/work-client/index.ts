// The extractable work-client module's single public surface (cutover stage-3 posting-flow plan
// §Architecture; DR-2026-08-05 decision 1). Nothing here imports from the rest of the host; see
// operator/test/architecture/native-requester-work-client-boundary.test.ts.
export {
  REQUESTER_ERROR_CATEGORIES,
  RequesterError,
  isRequesterError,
} from './errors.js';
export type { RequesterErrorCategory } from './errors.js';
export * from './preflight/index.js';
export * from './lifecycle/index.js';
export * from './delivery.js';
