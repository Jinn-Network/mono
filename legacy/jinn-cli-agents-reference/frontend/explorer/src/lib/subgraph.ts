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
  latestStatusUpdate?: string
  latestStatusUpdateAt?: string // Timestamp when latestStatusUpdate was captured
}

export interface Request {
  id: string
  mech: string
  sender: string
  workstreamId?: string
  ventureId?: string
  templateId?: string
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
  // Marketplace delivery fields (global Jinn explorer)
  deliveryMech?: string
  deliveryTxHash?: string
  deliveryBlockNumber?: string
  deliveryBlockTimestamp?: string
}

export interface DependencyInfo {
  id: string           // job definition ID
  jobName: string      // resolved job name
  delivered: boolean   // true if all requests delivered
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
  ventureId?: string
  workstreamId?: string
  templateId?: string
  name: string
  cid: string
  contentCid?: string
  topic: string
  contentPreview?: string
  type?: string
  documentType?: string
  tags?: string[]
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
  id: string  // The root request ID
  jobName: string
  blockTimestamp: string
  mech: string
  sender: string
  jobDefinitionId?: string
  childRequestCount?: number
  hasLauncherBriefing?: boolean
  delivered?: boolean
  lastActivity?: string
  lastStatus?: string
  ventureId?: string | null
  templateId?: string | null
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

export interface QueryOptions {
  limit?: number
  after?: string
  before?: string
  orderBy?: string
  orderDirection?: 'asc' | 'desc'
  where?: Record<string, unknown>
}

// Export query strings for testing
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
        latestStatusUpdate
        latestStatusUpdateAt
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

  const query = JOB_DEFINITIONS_QUERY

  try {
    const response = await request<JobDefinitionsResponse>(SUBGRAPH_URL, query, {
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
          ventureId
          templateId
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

// New fields added in ponder-sandbox schema — not yet on production
const ARTIFACT_EXTENDED_FIELDS = ['ventureId', 'workstreamId', 'templateId']

const ARTIFACTS_QUERY_EXTENDED = `
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
        ventureId
        workstreamId
        templateId
        name
        cid
        contentCid
        topic
        contentPreview
        type
        documentType
        tags
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

const ARTIFACTS_QUERY_LEGACY = `
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

// Track whether extended fields are supported to avoid repeated failures
let _artifactExtendedSupported: boolean | null = null

export async function queryArtifacts(options: QueryOptions = {}): Promise<PaginatedResponse<Artifact>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'requestId',
    orderDirection = 'desc',
    where
  } = options

  const vars = { limit, after, before, orderBy, orderDirection, where }

  // Try extended query first (unless we already know it's unsupported)
  if (_artifactExtendedSupported !== false) {
    try {
      const response = await request<ArtifactsResponse>(SUBGRAPH_URL, ARTIFACTS_QUERY_EXTENDED, vars)
      _artifactExtendedSupported = true
      return response.artifacts
    } catch (error) {
      const msg = String(error)
      if (msg.includes('GRAPHQL_VALIDATION_FAILED') || msg.includes('Cannot query field')) {
        console.warn('[queryArtifacts] Extended fields not supported, falling back to legacy query')
        _artifactExtendedSupported = false
      } else {
        console.error('Error querying artifacts:', error)
        return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
      }
    }
  }

  // Fallback: legacy query without extended fields, strip them from where filter too
  const legacyWhere = where
    ? Object.fromEntries(Object.entries(where).filter(([k]) => !ARTIFACT_EXTENDED_FIELDS.includes(k)))
    : where

  // If the where filter only had extended fields, it's now empty — return empty results
  if (where && Object.keys(legacyWhere || {}).length === 0 && Object.keys(where).length > 0) {
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }

  try {
    const response = await request<ArtifactsResponse>(
      SUBGRAPH_URL,
      ARTIFACTS_QUERY_LEGACY,
      { ...vars, where: legacyWhere }
    )
    return response.artifacts
  } catch (error) {
    console.error('Error querying artifacts (legacy):', error)
    return { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false } }
  }
}

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
      latestStatusUpdate
      latestStatusUpdateAt
    }
  }
`

export async function getJobDefinition(id: string): Promise<JobDefinition | null> {
  const query = JOB_DEFINITION_QUERY

  try {
    const response = await request<{ jobDefinition: JobDefinition | null }>(SUBGRAPH_URL, query, { id })
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
        jobInstanceStatusUpdate
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
        ventureId
        workstreamId
        templateId
        name
        cid
        contentCid
        topic
        contentPreview
        type
        documentType
        tags
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

export async function getRequestsAndDeliveries(options: QueryOptions = {}): Promise<{ requests: Request[], deliveries: Delivery[] }> {
  const [requestsResponse, deliveriesResponse] = await Promise.all([
    queryRequests(options),
    queryDeliveries(options)
  ])

  return { requests: requestsResponse.items, deliveries: deliveriesResponse.items }
}

// Helper to fetch job name by ID
export async function getJobName(jobDefinitionId: string): Promise<string | null> {
  try {
    const jobDef = await getJobDefinition(jobDefinitionId)
    return jobDef?.name || null
  } catch (error) {
    console.error('Error fetching job name:', error)
    return null
  }
}

// Helper to build CID candidates from hex digest
function buildCidV1HexCandidates(hexBytes: string): string[] {
  const hexClean = hexBytes.startsWith('0x') ? hexBytes.slice(2) : hexBytes
  // Try dag-pb (0x70) first, then raw (0x55) - dag-pb is used for directories
  return [
    `f01701220${hexClean}`,
    `f01551220${hexClean}`,
  ]
}

function isFullCidString(value: string): boolean {
  // Accept base32/base58 CIDs (baf*, Qm*) and hex-base16 CIDs (f01...)
  return /^baf|^Qm|^f01/i.test(value)
}

function extractDigestHexFromHexCid(hexCid: string): string | null {
  const s = hexCid.toLowerCase()
  if (s.startsWith('f01701220')) return s.slice(10)
  if (s.startsWith('f01551220')) return s.slice(10)
  return null
}

// Convert hex CID to base32 CID for directory access
function hexCidToBase32DagPb(hexCid: string): string | null {
  try {
    // Extract digest from raw codec CID
    const digestHex = hexCid.toLowerCase().replace(/^f01551220/i, '')
    if (digestHex === hexCid.toLowerCase()) return null // Not a raw codec CID

    // Convert hex digest to bytes
    const digestBytes: number[] = []
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16))
    }

    // Build CIDv1 dag-pb bytes: [0x01] + [0x70] (dag-pb) + multihash: [0x12, 0x20] + digest
    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes]

    // Base32 encode (lowercase, no padding)
    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
    let bitBuffer = 0
    let bitCount = 0
    let out = ''
    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff)
      bitCount += 8
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f
        bitCount -= 5
        out += base32Alphabet[idx]
      }
    }
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f
      out += base32Alphabet[idx]
    }

    return 'b' + out
  } catch (error) {
    console.error('[IPFS] Error converting hex CID to base32:', error)
    return null
  }
}

// Helper to fetch IPFS content with requestId for deliveries
export async function fetchIpfsContent(
  ipfsHash: string,
  requestId?: string,
  timeout: number = 10000
): Promise<{ content: string; contentType: string } | null> {
  const gatewayUrl = 'https://gateway.autonolas.tech/ipfs/'
  const fallbackGatewayUrl = 'https://ipfs.io/ipfs/'

  console.log(`[IPFS] Input hash: ${ipfsHash}, requestId: ${requestId || 'none'}`)

  const isFullCid = isFullCidString(ipfsHash)
  let candidates: string[]

  // For deliveries with requestId, convert to base32 for directory access
  if (requestId && isFullCid && /^f01551220/i.test(ipfsHash)) {
    // Delivery hash: convert from hex raw codec to base32 dag-pb codec
    const base32Cid = hexCidToBase32DagPb(ipfsHash)
    if (base32Cid) {
      console.log(`[IPFS] Converted hex CID to base32 for directory access: ${base32Cid}`)
      candidates = [base32Cid]
    } else {
      // Fallback to trying hex variants
      const digest = extractDigestHexFromHexCid(ipfsHash)
      if (digest) {
        candidates = [`f01701220${digest}`, `f01551220${digest}`]
      } else {
        candidates = [ipfsHash]
      }
    }
  } else if (isFullCid && /^f01/i.test(ipfsHash)) {
    // Request metadata: use hex CID as-is, try alternates
    if (ipfsHash.toLowerCase().startsWith('f01551220')) {
      const digest = extractDigestHexFromHexCid(ipfsHash)
      const dagPb = digest ? `f01701220${digest}` : null
      candidates = dagPb ? [ipfsHash, dagPb] : [ipfsHash]
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash)
      const raw = digest ? `f01551220${digest}` : null
      candidates = raw ? [ipfsHash, raw] : [ipfsHash]
    }
  } else if (isFullCid) {
    // Base32 or base58 CID - use as-is
    candidates = [ipfsHash]
  } else {
    // Hex digest without CID wrapper - build candidates
    candidates = buildCidV1HexCandidates(ipfsHash)
  }

  console.log(`[IPFS] CID candidates:`, candidates)

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    for (const cid of candidates) {
      // For delivery hashes, append /${requestId}
      const path = requestId ? `${cid}/${requestId}` : cid
      const url = `${gatewayUrl}${path}`

      console.log(`[IPFS] Attempting to fetch: ${url}`)

      let response: Response | undefined
      try {
        response = await fetch(url, {
          signal: controller.signal,
          mode: 'cors',
          cache: 'no-cache'
        })
        console.log(`[IPFS] Primary gateway response status: ${response.status}`)
      } catch (fetchError) {
        console.error(`[IPFS] Primary gateway failed:`, fetchError)
        // Try fallback gateway
        const fbUrl = `${fallbackGatewayUrl}${path}`
        console.log(`[IPFS] Trying fallback: ${fbUrl}`)
        try {
          response = await fetch(fbUrl, {
            signal: controller.signal,
            mode: 'cors',
            cache: 'no-cache'
          })
          console.log(`[IPFS] Fallback gateway response status: ${response.status}`)
        } catch (fallbackError) {
          console.error(`[IPFS] Fallback gateway failed:`, fallbackError)
          continue
        }
      }

      if (!response || !response.ok) {
        console.log(`[IPFS] Response not OK: ${response?.status} ${response?.statusText}`)
        continue
      }

      clearTimeout(timer)
      const contentType = response.headers.get('content-type') || 'text/plain'
      console.log(`[IPFS] Success! Content-Type: ${contentType}`)

      // Read as text first, then try to parse as JSON
      const text = await response.text()

      // Try to parse as JSON
      try {
        const json = JSON.parse(text)
        return {
          content: JSON.stringify(json, null, 2),
          contentType: 'application/json'
        }
      } catch {
        console.log(`[IPFS] Not JSON, treating as text`)
        // If JSON parsing fails, return as text
        return {
          content: text,
          contentType: contentType
        }
      }
    }

    clearTimeout(timer)
    return {
      content: '[Content not found at IPFS gateways]',
      contentType: 'text/plain'
    }
  } catch (error) {
    console.error('[IPFS] Error fetching IPFS content:', error)
    return {
      content: `[Error fetching content: ${error instanceof Error ? error.message : String(error)}]`,
      contentType: 'text/plain'
    }
  }
}

// Workstream queries
const queryWorkstreamsGql = `
  query Workstreams($limit: Int, $after: String, $before: String, $orderBy: String, $orderDirection: String, $where: workstreamFilter) {
    workstreams(
      orderBy: $orderBy
      orderDirection: $orderDirection
      limit: $limit
      after: $after
      before: $before
      where: $where
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
        lastStatus
        mech
        sender
        ventureId
        templateId
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

type WorkstreamRaw = {
  id: string
  rootRequestId: string
  jobName: string
  blockTimestamp: string
  lastActivity: string
  childRequestCount: number
  hasLauncherBriefing: boolean
  delivered: boolean
  lastStatus?: string
  mech: string
  sender: string
  ventureId?: string
  templateId?: string
}

function mapWorkstreamRaw(ws: WorkstreamRaw): Workstream {
  return {
    id: ws.id,
    jobName: ws.jobName,
    blockTimestamp: ws.blockTimestamp,
    mech: ws.mech,
    sender: ws.sender,
    childRequestCount: ws.childRequestCount,
    hasLauncherBriefing: ws.hasLauncherBriefing,
    delivered: ws.delivered,
    lastActivity: ws.lastActivity,
    ventureId: ws.ventureId,
    templateId: ws.templateId,
  }
}

export async function getWorkstreams(options: QueryOptions = {}): Promise<WorkstreamsResponse> {
  const { limit = 50, after, before, orderBy = 'blockTimestamp', orderDirection = 'desc' } = options

  try {
    const data = await request<{ workstreams: { items: WorkstreamRaw[], pageInfo: PageInfo } }>(SUBGRAPH_URL, queryWorkstreamsGql, {
      limit,
      after,
      before,
      orderBy,
      orderDirection
    })

    return {
      requests: {
        items: data.workstreams.items.map(mapWorkstreamRaw),
        pageInfo: data.workstreams.pageInfo
      }
    }
  } catch {
    // Workstreams table may not exist in older Ponder schema versions
    return {
      requests: {
        items: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: '', endCursor: '' }
      }
    }
  }
}

export async function queryWorkstreamsCollection(options: QueryOptions = {}): Promise<PaginatedResponse<Workstream>> {
  const {
    limit = 100,
    after,
    before,
    orderBy = 'lastActivity',
    orderDirection = 'desc',
    where
  } = options

  try {
    const data = await request<{ workstreams: { items: WorkstreamRaw[], pageInfo: PageInfo } }>(SUBGRAPH_URL, queryWorkstreamsGql, {
      limit,
      after,
      before,
      orderBy,
      orderDirection,
      where
    })

    return {
      items: data.workstreams.items.map(mapWorkstreamRaw),
      pageInfo: data.workstreams.pageInfo
    }
  } catch {
    return {
      items: [],
      pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: '', endCursor: '' }
    }
  }
}

export async function queryJobTemplateIdsByName(name: string, limit: number = 100): Promise<string[]> {
  if (!name.trim()) return []

  const query = `
    query JobTemplateIdsByName($name: String!, $limit: Int) {
      jobTemplates(where: { name_contains: $name }, limit: $limit) {
        items {
          id
        }
      }
    }
  `

  try {
    const response = await request<{ jobTemplates: { items: Array<{ id: string }> } }>(SUBGRAPH_URL, query, {
      name,
      limit,
    })
    return response.jobTemplates.items.map(item => item.id)
  } catch (error) {
    console.error('Error querying template IDs by name:', error)
    return []
  }
}

export async function queryWorkstreamIdsByName(name: string, limit: number = 200): Promise<string[]> {
  if (!name.trim()) return []

  try {
    const response = await request<{ workstreams: { items: Array<{ id: string }> } }>(SUBGRAPH_URL, queryWorkstreamsGql, {
      where: { jobName_contains: name },
      limit,
      orderBy: 'lastActivity',
      orderDirection: 'desc',
    })
    return response.workstreams.items.map(item => item.id)
  } catch (error) {
    console.error('Error querying workstream IDs by name:', error)
    return []
  }
}

export async function queryJobDefinitionsByName(
  name: string,
  limit: number = 200
): Promise<Array<{ id: string; workstreamId?: string }>> {
  if (!name.trim()) return []

  try {
    const response = await queryJobDefinitions({
      where: { name_contains: name },
      limit,
      orderBy: 'lastInteraction',
      orderDirection: 'desc',
    })

    return response.items.map(item => ({
      id: item.id,
      workstreamId: item.workstreamId,
    }))
  } catch (error) {
    console.error('Error querying job definitions by name:', error)
    return []
  }
}

const queryWorkstreamById = `
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

export async function getWorkstream(id: string): Promise<Workstream | null> {
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
    const data = await request<{ workstream: WorkstreamRaw | null }>(SUBGRAPH_URL, queryWorkstreamById, { id })

    if (!data.workstream) {
      return null
    }

    const ws = data.workstream
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
    console.error('Error fetching workstream:', error)
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
  // Use workstreamId to efficiently fetch all descendants in a single query
  // The workstreamId is the root request ID, so we query for all requests with that workstreamId
  try {
    const data = await request<RequestsResponse>(SUBGRAPH_URL, queryWorkstreamRequests, {
      workstreamId: rootRequestId,
      limit,
      orderBy: 'blockTimestamp',
      orderDirection: 'desc'
    })

    return data
  } catch {
    // workstreamId field may not exist in older Ponder schema versions
    return { requests: { items: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: '', endCursor: '' } } }
  }
}

const queryWorkstreamArtifacts = `
  query WorkstreamArtifacts($rootRequestId: String!, $topic: String!) {
    artifacts(
      where: { 
        AND: [
          { sourceRequestId: $rootRequestId },
          { topic: $topic }
        ]
      }
      orderBy: "blockTimestamp"
      orderDirection: "desc"
      limit: 1
    ) {
      items {
        id
        requestId
        sourceRequestId
        sourceJobDefinitionId
        ventureId
        workstreamId
        templateId
        name
        cid
        topic
        contentPreview
        blockTimestamp
      }
    }
  }
`

export async function getWorkstreamArtifact(rootRequestId: string, topic: string = 'launcher_briefing'): Promise<Artifact | null> {
  try {
    const data = await request<ArtifactsResponse>(SUBGRAPH_URL, queryWorkstreamArtifacts, {
      rootRequestId,
      topic
    })

    return data.artifacts.items[0] || null
  } catch {
    // sourceRequestId field may not exist in older Ponder schema versions
    return null
  }
}

// Fetch dependency information for a list of job definition IDs
export async function getDependencyInfo(jobDefIds: string[]): Promise<DependencyInfo[]> {
  if (!jobDefIds || jobDefIds.length === 0) {
    return []
  }

  const query = `
    query DependencyInfo($ids: [String!]!) {
      jobDefinitions(where: { id_in: $ids }) {
        items {
          id
          name
        }
      }
    }
  `

  try {
    const response = await request<{ jobDefinitions: { items: Array<{ id: string; name: string }> } }>(
      SUBGRAPH_URL,
      query,
      { ids: jobDefIds }
    )

    // For each job definition, query all its requests to determine overall status
    const jobDefs = response.jobDefinitions.items
    const dependencyInfo = await Promise.all(
      jobDefs.map(async (jobDef) => {
        // Query requests for this job definition
        const reqQuery = `
          query JobDefRequests($jobDefId: String!) {
            requests(where: { jobDefinitionId: $jobDefId }) {
              items {
                id
                delivered
                jobName
              }
            }
          }
        `
        const reqResponse = await request<{ requests: { items: Array<{ id: string; delivered: boolean; jobName?: string }> } }>(
          SUBGRAPH_URL,
          reqQuery,
          { jobDefId: jobDef.id }
        )

        const requests = reqResponse.requests.items
        const allDelivered = requests.length > 0 && requests.every(r => r.delivered)
        const anyDelivered = requests.some(r => r.delivered)

        return {
          id: jobDef.id,
          jobName: jobDef.name || 'Unknown Job',
          delivered: allDelivered,
          status: allDelivered ? 'delivered' : (anyDelivered ? 'in_progress' : 'pending') as 'pending' | 'in_progress' | 'delivered'
        }
      })
    )

    return dependencyInfo
  } catch (error) {
    console.error('Error fetching dependency info:', error)
    return []
  }
}

/**
 * Fetch MEASUREMENT artifacts for a workstream.
 * Returns all measurement artifacts from any job in the workstream.
 */
export async function getWorkstreamMeasurements(workstreamId: string): Promise<Artifact[]> {
  try {
    // Query artifacts with topic=MEASUREMENT where sourceRequestId matches the workstream
    const response = await queryArtifacts({
      where: {
        AND: [
          { sourceRequestId: workstreamId },
          { topic: 'MEASUREMENT' }
        ]
      },
      orderBy: 'blockTimestamp',
      orderDirection: 'desc',
      limit: 100
    })
    return response.items
  } catch {
    // sourceRequestId field may not exist in older Ponder schema versions
    return []
  }
}

// Find all requests that depend on a given request ID
export async function getDependents(requestId: string): Promise<DependencyInfo[]> {
  const query = `
    query Dependents($requestId: String!) {
      requests(where: { dependencies_has: $requestId }) {
        items {
          id
          jobName
          delivered
          blockTimestamp
        }
      }
    }
  `

  try {
    const response = await request<RequestsResponse>(SUBGRAPH_URL, query, { requestId })
    return response.requests.items.map(req => ({
      id: req.id,
      jobName: req.jobName || 'Unknown Job',
      delivered: req.delivered,
      status: req.delivered ? 'delivered' as const : 'pending' as const
    }))
  } catch (error) {
    console.error('Error querying dependents:', error)
    return []
  }
}
