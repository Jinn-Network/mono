/**
 * Milestone2GateSection — data container for the M2 gate card.
 *
 * Fetches the #647-pinned slice (harness=codex, model=gpt-5.4-mini, window=30),
 * computes the gate, and renders the presentational Milestone2GateCard. Kept
 * separate from SolverNetView (and rendered only on the M2 SolverNet) so its
 * extra slice fetch never runs — nor pollutes slice-arg assertions — on other
 * nets.
 */

import { useSlice, type SliceParams } from '../lib/api';
import { Milestone2GateCard } from './Milestone2GateCard';
import {
  computeMilestone2Gate,
  MILESTONE2_HARNESS,
  MILESTONE2_MODEL,
  MILESTONE2_WINDOW,
} from '../lib/milestone2';

export function Milestone2GateSection({ cid }: { cid: string }) {
  const params: SliceParams = {
    manifestDigest: cid,
    group: 'none',
    filter: { harness: [MILESTONE2_HARNESS], model: [MILESTONE2_MODEL] },
    includeUnenriched: false,
    bucket: 'auto',
    window: MILESTONE2_WINDOW,
  };
  const { data, isLoading } = useSlice(params);
  const gate = data
    ? computeMilestone2Gate(data.series[0]?.rolling ?? [])
    : null;
  return <Milestone2GateCard gate={gate} loading={isLoading} />;
}
