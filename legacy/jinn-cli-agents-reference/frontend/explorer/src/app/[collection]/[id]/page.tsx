import { Metadata } from 'next'
import { RecordPageProps, collectionNames } from '@/lib/types'
import { SubgraphDetailView } from '@/components/subgraph-detail-view'
import { getCollectionLabel } from '@/lib/utils'
import { notFound } from 'next/navigation'
import { SiteHeader } from '@/components/site-header'
import { 
  getJobDefinition, 
  getRequest, 
  getDelivery, 
  getArtifact,
  JobDefinition,
  Request,
  Delivery,
  Artifact
} from '@/lib/subgraph'

type SubgraphRecord = JobDefinition | Request | Delivery | Artifact

// Truncate text for browser tab title (short, with ellipsis)
function truncateForTitle(text: string, maxLength: number = 10): string {
  if (text.length <= maxLength) return text
  return text.substring(0, maxLength) + '…'
}

// Helper function to get human-readable title from record
function getRecordTitle(record: SubgraphRecord, collectionName: string): string {
  // Job definitions have names
  if ('name' in record && record.name) {
    return record.name.length > 50 ? record.name.substring(0, 50) + '...' : record.name
  }
  
  // Requests can have job names
  if ('jobName' in record && record.jobName) {
    return record.jobName.length > 50 ? record.jobName.substring(0, 50) + '...' : record.jobName
  }
  
  // Artifacts have topics
  if ('topic' in record && record.topic) {
    return record.topic.length > 50 ? record.topic.substring(0, 50) + '...' : record.topic
  }
  
  // Fallback to collection name + shortened ID
  return `${collectionName.slice(0, -1)} ${record.id.toString().substring(0, 8)}...`
}

// Get short title for browser tab
function getRecordTitleShort(record: SubgraphRecord): string {
  if ('name' in record && record.name) {
    return truncateForTitle(record.name)
  }
  if ('jobName' in record && record.jobName) {
    return truncateForTitle(record.jobName)
  }
  if ('topic' in record && record.topic) {
    return truncateForTitle(record.topic)
  }
  return truncateForTitle(record.id.toString())
}

async function fetchRecord(collection: string, id: string): Promise<SubgraphRecord | null> {
  switch (collection) {
    case 'jobDefinitions':
      return await getJobDefinition(id)
    case 'requests':
      return await getRequest(id)
    case 'deliveries':
      return await getDelivery(id)
    case 'artifacts':
      return await getArtifact(id)
    default:
      return null
  }
}

export async function generateMetadata({ params }: RecordPageProps): Promise<Metadata> {
  const resolvedParams = await params
  
  if (!collectionNames.includes(resolvedParams.collection)) {
    return { title: 'Not Found' }
  }
  
  const decodedId = decodeURIComponent(resolvedParams.id)
  const collectionLabel = getCollectionLabel(resolvedParams.collection)
  
  try {
    const record = await fetchRecord(resolvedParams.collection, decodedId)
    
    if (!record) {
      return { title: `Not Found | ${collectionLabel}` }
    }
    
    const recordTitle = getRecordTitle(record, resolvedParams.collection)
    const recordTitleShort = getRecordTitleShort(record)
    
    return {
      title: `${recordTitleShort} | ${collectionLabel}`,
      description: `View details for ${recordTitle} in ${collectionLabel}`,
    }
  } catch {
    return { title: collectionLabel }
  }
}

export default async function RecordPage({ params }: RecordPageProps) {
  const resolvedParams = await params
  
  // Validate that the collection name is valid
  if (!collectionNames.includes(resolvedParams.collection)) {
    notFound()
  }
  
  // Decode the ID parameter (e.g., %3A -> :)
  const decodedId = decodeURIComponent(resolvedParams.id)
  const collectionLabel = getCollectionLabel(resolvedParams.collection)
  
  try {
    // Fetch data from subgraph
    const record = await fetchRecord(resolvedParams.collection, decodedId)

    if (!record) {
      notFound()
    }

    const recordTitle = getRecordTitle(record, resolvedParams.collection)

    const breadcrumbs = [
      { label: collectionLabel, href: `/${resolvedParams.collection}` },
      { label: recordTitle }
    ]

    return (
      <>
        <SiteHeader breadcrumbs={breadcrumbs} />
        <div className="p-4 md:p-6">
          <SubgraphDetailView record={record} collectionName={resolvedParams.collection} />
        </div>
      </>
    )
  } catch (error) {
    const errorBreadcrumbs = [
      { label: collectionLabel, href: `/${resolvedParams.collection}` },
      { label: 'Error loading record' }
    ]

    return (
      <>
        <SiteHeader breadcrumbs={errorBreadcrumbs} />
        <div className="p-4 md:p-6">
          <p className="text-gray-400">
            Unable to fetch record {decodedId} from the {resolvedParams.collection} collection. 
            Please check the subgraph connection and try again.
          </p>
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-gray-500">
              Error details
            </summary>
            <pre className="mt-2 p-2 bg-gray-100 rounded text-xs overflow-auto">
              {error instanceof Error ? error.message : 'Unknown error'}
            </pre>
          </details>
        </div>
      </>
    )
  }
}