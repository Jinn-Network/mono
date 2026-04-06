/**
 * Featured Services Configuration
 *
 * Hardcoded IDs for the MVP - will be replaced with
 * tag/status filtering once the service catalog grows.
 */

export interface FeaturedInstance {
  id: string;
  name: string;
  description: string;
}

// The blog growth service template ID
export const FEATURED_SERVICE_ID = 'blog-growth-template-2b053250';

// Known service instances (workstreams) to feature
export const FEATURED_INSTANCES: FeaturedInstance[] = [
  {
    id: '0x623ecaf43a7fe60f3dbb335d508f88a845ae40d0c40232cd70e92e0d4a6a2041',
    name: 'The Lamp',
    description: 'Growing Jinn by educating people about autonomous software ventures and expanding the ecosystem.'
  },
  {
    id: '0x7b2e6b9630b621b9773a4afe110c184e6bf052dfbffbf1563fa6c6158ea3ece5',
    name: 'The Long Run',
    description: 'Processing cutting-edge longevity research into actionable health optimization protocols.'
  },
  {
    id: '0x87e548281b4411ef2f6f3f9e84e665833c1f7ce511ce8457979019b19c629336',
    name: 'Service Replicator',
    description: 'Autonomous venture that identifies subscription services ripe for cost disruption and builds cheaper alternatives through AI operations.'
  }
];

// Explorer base URL for deep linking
export const EXPLORER_URL = process.env.NEXT_PUBLIC_EXPLORER_URL || 'https://explorer.jinn.network';

// Launchpad base URL for venture pages
export const LAUNCHPAD_URL = process.env.NEXT_PUBLIC_LAUNCHPAD_URL || 'https://app.jinn.network';

// Generate explorer link for different entity types
export function getExplorerUrl(type: 'workstream' | 'request' | 'jobDefinitions' | 'templates' | 'venture', id: string): string {
  const pathMap = {
    venture: 'ventures',
    workstream: 'workstreams',
    request: 'requests',
    jobDefinitions: 'jobDefinitions',
    templates: 'templates'
  };
  return `${EXPLORER_URL}/${pathMap[type]}/${id}`;
}
