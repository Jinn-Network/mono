import * as React from 'react';
/**
 * States whether the method was fixed before the official run, and carries the digest and timestamp that make that checkable.
 * This is the product's core trust signal — it reports a fact about sequence, not a judgement about quality.
 */
export interface MethodLockProps {
  state?: 'draft' | 'locked' | 'amended';
  /** Content digest of the locked method, e.g. "sha256:9f3c…a71b". */
  digest?: string;
  /** ISO timestamp of the lock. */
  timestamp?: string;
  /** Link to the full method document. */
  detailHref?: string;
  /** One-line form for table rows and app headers. */
  compact?: boolean;
  style?: React.CSSProperties;
}
export declare function MethodLock(props: MethodLockProps): JSX.Element;
