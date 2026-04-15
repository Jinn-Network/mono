import { Metadata } from 'next'
import { CollectionPageProps, collectionNames, CollectionName } from '@/lib/types'
import { CollectionView } from '@/components/collection-view'
import { getCollectionLabel } from '@/lib/utils'
import { notFound } from 'next/navigation'

// Description map for each collection
const collectionDescriptions: Record<CollectionName, string> = {
  jobDefinitions: 'Browse all job definitions - reusable job templates and configurations',
  requests: 'Browse all job runs - individual job executions and their results',
  deliveries: 'Browse all deliveries - completed job outputs and artifacts',
  artifacts: 'Browse all artifacts - files, documents, and data produced by jobs',
  messages: 'Browse all messages - communication records between jobs',
  templates: 'Browse job templates - callable workflows via x402 payments',
  workstreams: 'Browse all workstreams - top-level job executions and their downstream graphs',
}

export async function generateMetadata({ params }: CollectionPageProps): Promise<Metadata> {
  const resolvedParams = await params
  
  if (!collectionNames.includes(resolvedParams.collection)) {
    return { title: 'Not Found' }
  }
  
  const label = getCollectionLabel(resolvedParams.collection)
  const description = collectionDescriptions[resolvedParams.collection]
  
  return {
    title: label,
    description,
  }
}

export default async function CollectionPage({ params }: CollectionPageProps) {
  const resolvedParams = await params
  
  // Validate that the collection name is valid
  if (!collectionNames.includes(resolvedParams.collection)) {
    notFound()
  }

  return <CollectionView collectionName={resolvedParams.collection} />
}