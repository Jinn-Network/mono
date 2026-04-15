import { request } from 'graphql-request'

const SUBGRAPH_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'https://indexer.jinn.network/graphql'

export interface JobDefinition {
  id: string
  name: string
  enabledTools: string[]
  blueprint?: string
  workstreamId?: string
  sourceJobDefinitionId?: string
  sourceRequestId?: string
  codeMetadata?: Record<string, unknown>
  dependencies?: string[]
  createdAt?: string
  lastInteraction?: string
  lastStatus?: string
}

export interface Request {
  id: string
  mech: string
  sender: string
  workstreamId?: string
  jobDefinitionId?: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  requestData?: string
  ipfsHash?: string
  deliveryIpfsHash?: string
  transactionHash?: string
  blockNumber: string
  blockTimestamp: string
  delivered: boolean
  jobName?: string
  enabledTools: string[]
  additionalContext?: Record<string, unknown>
  dependencies?: string[]
  deliveryMech?: string
  deliveryTxHash?: string
  deliveryBlockNumber?: string
  deliveryBlockTimestamp?: string
}

export interface DependencyInfo {
  id: string
  jobName: string
  delivered: boolean
  status: 'pending' | 'in_progress' | 'delivered'
}

export interface Delivery {
  id: string
  requestId: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  mech: string
  mechServiceMultisig: string
  deliveryRate: string
  ipfsHash?: string
  transactionHash: string
  blockNumber: string
  blockTimestamp: string
  jobInstanceStatusUpdate?: string
}

export interface Artifact {
  id: string
  requestId: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  name: string
  cid: string
  topic: string
  contentPreview?: string
  blockTimestamp?: string
}

export interface Message {
  id: string
  requestId: string
  sourceRequestId?: string
  sourceJobDefinitionId?: string
  to?: string
  content: string
  blockTimestamp: string
}

export interface Workstream {
  id: string
  jobName: string
  blockTimestamp: string
  mech: string
  sender: string
  jobDefinitionId?: string
  childRequestCount?: number
  hasLauncherBriefing?: boolean
  delivered?: boolean
  lastActivity?: string
}

export interface JobTemplate {
  id: string
  name: string
  description?: string
  tags?: string[]
  enabledTools?: string[]
  blueprintHash?: string
  blueprint?: string
  inputSchema?: string
  outputSpec?: string
  priceWei?: string
  priceUsd?: string
  canonicalJobDefinitionId?: string
  runCount?: number
  successCount?: number
  avgDurationSeconds?: number
  avgCostWei?: string
  createdAt?: string
  lastUsedAt?: string
  status?: 'visible' | 'hidden' | 'deprecated'
  defaultCyclic?: boolean
}

export interface PageInfo {
  hasNextPage: boolean
  hasPreviousPage: boolean
  startCursor?: string
  endCursor?: string
}

export interface PaginatedResponse<T> {
  items: T[]
  pageInfo: PageInfo
}

export interface JobDefinitionsResponse {
  jobDefinitions: {
    items: JobDefinition[]
    pageInfo: PageInfo
  }
}

export interface RequestsResponse {
  requests: {
    items: Request[]
    pageInfo: PageInfo
  }
}

export interface DeliveriesResponse {
  deliverys: {
    items: Delivery[]
    pageInfo: PageInfo
  }
}

export interface ArtifactsResponse {
  artifacts: {
    items: Artifact[]
    pageInfo: PageInfo
  }
}

export interface MessagesResponse {
  messages: {
    items: Message[]
    pageInfo: PageInfo
  }
}

export interface WorkstreamsResponse {
  requests: {
    items: Workstream[]
    pageInfo: PageInfo
  }
}

export interface JobTemplatesResponse {
  jobTemplates: {
    items: JobTemplate[]
    pageInfo: PageInfo
  }
}

export interface QueryOptions {
  limit?: number
  after?: string
  before?: string
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
  where?: Record<string, unknown>
}

// Job Definitions
export const JOB_DEFINITIONS_QUERY = `
  query JobDefinitions($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: jobDefinitionFilter) {
    jobDefinitions(
      limit: $limit,
      after: $after,
      before: $before,
      orderBy: $orderBy,
      orderDirection: $orderDirection,
      where: $where
    ) {
      items {
        id
        name
        enabledTools
        blueprint
        workstreamId
        sourceJobDefinitionId
        sourceRequestId
        codeMetadata
        dependencies
        createdAt
        lastInteraction
        lastStatus
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`

export async function queryJobDefinitions(options: QueryOptions = {}): Promise<PaginatedResponse<JobDefinition>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'lastInteraction',
    orderDirection = 'desc',
    where
  } = options

  try {
    const response = await request<JobDefinitionsResponse>(SUBGRAPH_URL, JOB_DEFINITIONS_QUERY, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.jobDefinitions
  } catch (error) {
    console.error('Error querying job definitions:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

export async function queryRequests(options: QueryOptions = {}): Promise<PaginatedResponse<Request>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'blockTimestamp',
    orderDirection = 'desc',
    where
  } = options

  const query = `
    query Requests($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: requestFilter) {
      requests(
        limit: $limit,
        after: $after,
        before: $before,
        orderBy: $orderBy,
        orderDirection: $orderDirection,
        where: $where
      ) {
        items {
          id
          mech
          sender
          workstreamId
          jobDefinitionId
          sourceRequestId
          sourceJobDefinitionId
          requestData
          ipfsHash
          deliveryIpfsHash
          transactionHash
          blockNumber
          blockTimestamp
          delivered
          jobName
          enabledTools
          additionalContext
          dependencies
          deliveryMech
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `

  try {
    const response = await request<RequestsResponse>(SUBGRAPH_URL, query, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.requests
  } catch (error) {
    console.error('Error querying requests:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

export async function queryDeliveries(options: QueryOptions = {}): Promise<PaginatedResponse<Delivery>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'blockTimestamp',
    orderDirection = 'desc',
    where
  } = options

  const query = `
    query Deliveries($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: deliveryFilter) {
      deliverys(
        limit: $limit,
        after: $after,
        before: $before,
        orderBy: $orderBy,
        orderDirection: $orderDirection,
        where: $where
      ) {
        items {
          id
          requestId
          sourceRequestId
          sourceJobDefinitionId
          mech
          mechServiceMultisig
          deliveryRate
          ipfsHash
          transactionHash
          blockNumber
          blockTimestamp
          jobInstanceStatusUpdate
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `

  try {
    const response = await request<DeliveriesResponse>(SUBGRAPH_URL, query, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.deliverys
  } catch (error) {
    console.error('Error querying deliveries:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

export async function queryArtifacts(options: QueryOptions = {}): Promise<PaginatedResponse<Artifact>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'requestId',
    orderDirection = 'desc',
    where
  } = options

  const query = `
    query Artifacts($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: artifactFilter) {
      artifacts(
        limit: $limit,
        after: $after,
        before: $before,
        orderBy: $orderBy,
        orderDirection: $orderDirection,
        where: $where
      ) {
        items {
          id
          requestId
          sourceRequestId
          sourceJobDefinitionId
          name
          cid
          topic
          contentPreview
          blockTimestamp
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `

  try {
    const response = await request<ArtifactsResponse>(SUBGRAPH_URL, query, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.artifacts
  } catch (error) {
    console.error('Error querying artifacts:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

export async function queryMessages(options: QueryOptions = {}): Promise<PaginatedResponse<Message>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'blockTimestamp',
    orderDirection = 'desc',
    where
  } = options

  const query = `
    query Messages($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: messageFilter) {
      messages(
        limit: $limit,
        after: $after,
        before: $before,
        orderBy: $orderBy,
        orderDirection: $orderDirection,
        where: $where
      ) {
        items {
          id
          requestId
          sourceRequestId
          sourceJobDefinitionId
          to
          content
          blockTimestamp
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `

  try {
    const response = await request<MessagesResponse>(SUBGRAPH_URL, query, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.messages
  } catch (error) {
    console.error('Error querying messages:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

// Single record fetchers
export const JOB_DEFINITION_QUERY = `
  query JobDefinition($id: String!) {
    jobDefinition(id: $id) {
      id
      name
      enabledTools
      blueprint
      workstreamId
      sourceJobDefinitionId
      sourceRequestId
      codeMetadata
      dependencies
      createdAt
      lastInteraction
      lastStatus
    }
  }
`

export async function getJobDefinition(id: string): Promise<JobDefinition | null> {
  try {
    const response = await request<{ jobDefinition: JobDefinition | null }>(SUBGRAPH_URL, JOB_DEFINITION_QUERY, { id })
    return response.jobDefinition
  } catch (error) {
    console.error('Error querying job definition:', error)
    return null
  }
}

export async function getRequest(id: string): Promise<Request | null> {
  const query = `
    query Request($id: String!) {
      request(id: $id) {
        id
        mech
        sender
        workstreamId
        jobDefinitionId
        sourceRequestId
        sourceJobDefinitionId
        requestData
        ipfsHash
        deliveryIpfsHash
        transactionHash
        blockNumber
        blockTimestamp
        delivered
        jobName
        enabledTools
        additionalContext
        dependencies
      }
    }
  `

  try {
    const response = await request<{ request: Request | null }>(SUBGRAPH_URL, query, { id })
    return response.request
  } catch (error) {
    console.error('Error querying request:', error)
    return null
  }
}

export async function getDelivery(id: string): Promise<Delivery | null> {
  const query = `
    query Delivery($id: String!) {
      delivery(id: $id) {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        mech
        mechServiceMultisig
        deliveryRate
        ipfsHash
        transactionHash
        blockNumber
        blockTimestamp
      }
    }
  `

  try {
    const response = await request<{ delivery: Delivery | null }>(SUBGRAPH_URL, query, { id })
    return response.delivery
  } catch (error) {
    console.error('Error querying delivery:', error)
    return null
  }
}

export async function getArtifact(id: string): Promise<Artifact | null> {
  const query = `
    query Artifact($id: String!) {
      artifact(id: $id) {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        name
        cid
        topic
        contentPreview
        blockTimestamp
      }
    }
  `

  try {
    const response = await request<{ artifact: Artifact | null }>(SUBGRAPH_URL, query, { id })
    return response.artifact
  } catch (error) {
    console.error('Error querying artifact:', error)
    return null
  }
}

export async function getMessage(id: string): Promise<Message | null> {
  const query = `
    query Message($id: String!) {
      message(id: $id) {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        to
        content
        blockTimestamp
      }
    }
  `

  try {
    const response = await request<{ message: Message | null }>(SUBGRAPH_URL, query, { id })
    return response.message
  } catch (error) {
    console.error('Error querying message:', error)
    return null
  }
}

// Workstream queries
const queryWorkstreamsGQL = `
  query Workstreams($limit: Int, $orderBy: String, $orderDirection: String) {
    workstreams(
      orderBy: $orderBy
      orderDirection: $orderDirection
      limit: $limit
    ) {
      items {
        id
        rootRequestId
        jobName
        blockTimestamp
        lastActivity
        childRequestCount
        hasLauncherBriefing
        delivered
        mech
        sender
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`

export async function getWorkstreams(options: QueryOptions = {}): Promise<WorkstreamsResponse> {
  const { limit = 50, orderBy = 'blockTimestamp', orderDirection = 'desc' } = options

  type WorkstreamRaw = {
    id: string
    rootRequestId: string
    jobName: string
    blockTimestamp: string
    lastActivity: string
    childRequestCount: number
    hasLauncherBriefing: boolean
    delivered: boolean
    mech: string
    sender: string
  }

  const data = await request<{ workstreams: { items: WorkstreamRaw[], pageInfo: PageInfo } }>(SUBGRAPH_URL, queryWorkstreamsGQL, {
    limit,
    orderBy,
    orderDirection
  })

  return {
    requests: {
      items: data.workstreams.items.map(ws => ({
        id: ws.id,
        jobName: ws.jobName,
        blockTimestamp: ws.blockTimestamp,
        mech: ws.mech,
        sender: ws.sender,
        workstreamId: ws.id,
        childRequestCount: ws.childRequestCount,
        hasLauncherBriefing: ws.hasLauncherBriefing,
        delivered: ws.delivered,
        lastActivity: ws.lastActivity
      })),
      pageInfo: data.workstreams.pageInfo
    }
  }
}

export async function getWorkstream(id: string): Promise<Workstream | null> {
  const query = `
    query Workstream($id: String!) {
      workstream(id: $id) {
        id
        rootRequestId
        jobName
        blockTimestamp
        lastActivity
        childRequestCount
        hasLauncherBriefing
        delivered
        mech
        sender
      }
    }
  `

  type WorkstreamRaw = {
    id: string
    rootRequestId: string
    jobName: string
    blockTimestamp: string
    lastActivity: string
    childRequestCount: number
    hasLauncherBriefing: boolean
    delivered: boolean
    mech: string
    sender: string
  }

  try {
    const response = await request<{ workstream: WorkstreamRaw | null }>(SUBGRAPH_URL, query, { id })
    if (!response.workstream) return null

    const ws = response.workstream
    return {
      id: ws.id,
      jobName: ws.jobName,
      blockTimestamp: ws.blockTimestamp,
      mech: ws.mech,
      sender: ws.sender,
      childRequestCount: ws.childRequestCount,
      hasLauncherBriefing: ws.hasLauncherBriefing,
      delivered: ws.delivered,
      lastActivity: ws.lastActivity
    }
  } catch (error) {
    console.error('Error querying workstream:', error)
    return null
  }
}

const queryWorkstreamRequests = `
  query WorkstreamRequests($workstreamId: String!, $limit: Int, $orderBy: String, $orderDirection: String) {
    requests(
      where: { workstreamId: $workstreamId }
      orderBy: $orderBy
      orderDirection: $orderDirection
      limit: $limit
    ) {
      items {
        id
        jobName
        blockTimestamp
        delivered
        jobDefinitionId
        workstreamId
      }
      pageInfo {
        hasNextPage
        hasPreviousPage
        startCursor
        endCursor
      }
    }
  }
`

export async function getWorkstreamRequests(rootRequestId: string, limit: number = 10): Promise<RequestsResponse> {
  const data = await request<RequestsResponse>(SUBGRAPH_URL, queryWorkstreamRequests, {
    workstreamId: rootRequestId,
    limit,
    orderBy: 'blockTimestamp',
    orderDirection: 'desc'
  })

  return data
}

// Job Templates (Services)
export async function queryJobTemplates(options: QueryOptions = {}): Promise<PaginatedResponse<JobTemplate>> {
  const {
    limit = 50,
    after,
    before,
    orderBy = 'lastUsedAt',
    orderDirection = 'desc',
    where
  } = options

  const query = `
    query JobTemplates($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: jobTemplateFilter) {
      jobTemplates(
        limit: $limit,
        after: $after,
        before: $before,
        orderBy: $orderBy,
        orderDirection: $orderDirection,
        where: $where
      ) {
        items {
          id
          name
          description
          tags
          enabledTools
          blueprintHash
          blueprint
          inputSchema
          outputSpec
          priceWei
          priceUsd
          canonicalJobDefinitionId
          runCount
          successCount
          avgDurationSeconds
          avgCostWei
          createdAt
          lastUsedAt
          status
          defaultCyclic
        }
        pageInfo {
          hasNextPage
          hasPreviousPage
          startCursor
          endCursor
        }
      }
    }
  `

  try {
    const response = await request<JobTemplatesResponse>(SUBGRAPH_URL, query, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })
    return response.jobTemplates
  } catch (error) {
    console.error('Error querying job templates:', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

export async function getJobTemplate(id: string): Promise<JobTemplate | null> {
  const query = `
    query JobTemplate($id: String!) {
      jobTemplate(id: $id) {
        id
        name
        description
        tags
        enabledTools
        blueprintHash
        blueprint
        inputSchema
        outputSpec
        priceWei
        priceUsd
        canonicalJobDefinitionId
        runCount
        successCount
        avgDurationSeconds
        avgCostWei
        createdAt
        lastUsedAt
        status
        defaultCyclic
      }
    }
  `

  try {
    const response = await request<{ jobTemplate: JobTemplate | null }>(SUBGRAPH_URL, query, { id })
    return response.jobTemplate
  } catch (error) {
    console.error('Error querying job template:', error)
    return null
  }
}

// Helper functions
export async function getRequestsAndDeliveries(options: QueryOptions = {}): Promise<{ requests: Request[], deliveries: Delivery[] }> {
  const [requestsResponse, deliveriesResponse] = await Promise.all([
    queryRequests(options),
    queryDeliveries(options)
  ])

  return { requests: requestsResponse.items, deliveries: deliveriesResponse.items }
}

export async function getJobName(jobDefinitionId: string): Promise<string | null> {
  try {
    const jobDef = await getJobDefinition(jobDefinitionId)
    return jobDef?.name || null
  } catch (error) {
    console.error('Error fetching job name:', error)
    return null
  }
}
