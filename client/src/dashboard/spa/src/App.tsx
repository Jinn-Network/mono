import { useQuery } from '@tanstack/react-query';
import { api } from './api/client.js';
import type { BootstrapState } from './api/types.js';
import { LoadingScreen } from './regions/LoadingScreen.js';
import { Onboarding } from './regions/Onboarding.js';
import { Operating } from './regions/Operating.js';

/**
 * App routes between two distinct phases of operator life:
 *
 *   Onboarding — bootstrap not yet 'running'. A focused, full-screen flow that
 *                narrates the 11-step state machine and surfaces only the
 *                actions the operator can take right now (fund, sign in).
 *
 *   Operating  — bootstrap complete. A dashboard that leads with the metrics
 *                a steady-state operator actually checks (earnings, gas,
 *                in-flight intents) and routes recurring actions through a
 *                single column. Activity is collapsed by default; the agent
 *                takes the right column at proper width.
 *
 * The split is intentional: onboarding is a one-time experience, not a
 * permanent dashboard region. Once bootstrap completes, the step list goes
 * away and the operator stays in Operating forever.
 */
export default function App(): JSX.Element {
  const { data, isLoading } = useQuery<BootstrapState>({
    queryKey: ['bootstrap'],
    queryFn: () => api.getBootstrap(),
    refetchInterval: 1500,
  });

  // While the very first /v1/bootstrap poll hasn't returned OR the daemon is
  // still 'uninitialized' (init hasn't finished writing the keystore), show
  // the loading screen instead of flashing into onboarding.
  if (isLoading || !data || data.mode === 'uninitialized') {
    const headline = !data
      ? 'Starting jinn'
      : data.mode === 'uninitialized'
        ? 'Setting up your wallet'
        : 'Loading';
    return <LoadingScreen headline={headline} />;
  }

  if (data.mode !== 'running') {
    return <Onboarding />;
  }

  return <Operating />;
}
