import { NextRequest, NextResponse } from 'next/server'
import { request } from 'graphql-request'

const PONDER_URL = process.env.NEXT_PUBLIC_SUBGRAPH_URL || 'https://indexer.jinn.network/graphql'

// Query to get SITUATION artifact for a request
const GET_SITUATION_ARTIFACT = `
  query GetSituationArtifact($requestId: String!) {
    artifacts(
      where: { 
        AND: [
          { requestId: $requestId },
          { topic: "SITUATION" }
        ]
      }
      limit: 1
    ) {
      items {
        id
        requestId
        name
        cid
        topic
        contentPreview
        blockTimestamp
      }
    }
  }
`


// Helper to fetch IPFS content with delivery directory reconstruction
async function fetchIpfsContent(cid: string, requestIdForDelivery?: string): Promise<Record<string, unknown> | null> {
  const gatewayUrl = 'https://gateway.autonolas.tech/ipfs/'
  let url = `${gatewayUrl}${cid}`
  
  // Special handling for delivery IPFS hashes: reconstruct directory path
  // Delivery uses wrap-with-directory, so CID points to directory structure bytes
  // We need to fetch: {dir-CID}/{requestId}
  if (requestIdForDelivery && cid.startsWith('f01551220')) {
    const digestHex = cid.replace(/^f01551220/i, '')
    
    try {
      // Convert hex digest to bytes
      const digestBytes: number[] = []
      for (let i = 0; i < digestHex.length; i += 2) {
        digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16))
      }
      
      // Build CIDv1 bytes: [0x01] + [0x70] (dag-pb) + multihash: [0x12, 0x20] + digest
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
      
      const dirCid = 'b' + out
      url = `${gatewayUrl}${dirCid}/${requestIdForDelivery}`
      console.log(`[API] Reconstructed delivery directory CID: ${dirCid}`)
    } catch (e) {
      console.error(`[API] Failed to reconstruct directory CID:`, e)
    }
  }
  
  try {
    const response = await fetch(url, {
      cache: 'no-cache',
      headers: {
        'Accept': 'application/json'
      }
    })
    
    if (!response.ok) {
      throw new Error(`IPFS fetch failed: ${response.status}`)
    }
    
    const text = await response.text()
    return JSON.parse(text)
  } catch (error) {
    console.error('[API] Error fetching IPFS content:', error)
    return null
  }
}

interface RecognitionData {
  searchQuery?: string
  similarJobs?: Array<{
    requestId: string
    score: number
    jobName?: string
  }>
  learnings?: string
  learningsMarkdown?: string
  initialSituation?: Record<string, unknown>
  embeddingStatus?: string
  progressCheckpoint?: {
    checkpointSummary: string
    workstreamJobs?: Array<{
      requestId: string
      jobName?: string
      blockTimestamp: string
      deliverySummary?: string
    }>
    stats?: {
      totalJobs: number
      completedJobs: number
    }
  }
}

interface ReflectionData {
  output?: string
  telemetry?: Record<string, unknown>
}

interface DeliveryDataResponse {
  recognition?: RecognitionData
  reflection?: ReflectionData
}

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams
  const requestId = searchParams.get('requestId')

  if (!requestId) {
    return NextResponse.json(
      { error: 'requestId is required' },
      { status: 400 }
    )
  }

  try {
    let recognitionData = null
    let reflectionData = null
    let situationData = null

    // PRIORITY 1: Fetch delivery data (contains recognition and reflection)
    const GET_REQUEST_WITH_DELIVERY = `
      query GetRequestWithDelivery($requestId: String!) {
        requests(where: { id: $requestId }) {
          items {
            id
            deliveryIpfsHash
            delivered
          }
        }
      }
    `
    
    const requestResponse = await request<{
      requests: { items: Array<{ deliveryIpfsHash?: string; delivered: boolean }> }
    }>(PONDER_URL, GET_REQUEST_WITH_DELIVERY, { requestId })

    if (requestResponse.requests.items.length > 0 && requestResponse.requests.items[0].delivered) {
      const deliveryHash = requestResponse.requests.items[0].deliveryIpfsHash
      if (deliveryHash) {
        const deliveryData = await fetchIpfsContent(deliveryHash, requestId) as DeliveryDataResponse | null
        if (deliveryData) {
          // Extract recognition data from delivery
          if (deliveryData.recognition) {
            recognitionData = {
              searchQuery: deliveryData.recognition.searchQuery,
              similarJobs: deliveryData.recognition.similarJobs || [],
              learnings: deliveryData.recognition.learningsMarkdown || deliveryData.recognition.learnings,
              initialSituation: deliveryData.recognition.initialSituation,
              embeddingStatus: deliveryData.recognition.embeddingStatus,
              progressCheckpoint: deliveryData.recognition.progressCheckpoint
            }
            console.log('[API] Found recognition data in delivery')
          }
          
          // Extract reflection data from delivery
          if (deliveryData.reflection) {
            reflectionData = {
              output: deliveryData.reflection.output,
              telemetry: deliveryData.reflection.telemetry
            }
            console.log('[API] Found reflection data in delivery')
          }
        }
      }
    }

    // FALLBACK 1: Fetch RECOGNITION_RESULT artifact if we didn't get recognition from delivery
    if (!recognitionData) {
      const GET_RECOGNITION_ARTIFACT = `
        query GetRecognitionArtifact($requestId: String!) {
          artifacts(
            where: { 
              AND: [
                { requestId: $requestId },
                { topic: "RECOGNITION_RESULT" }
              ]
            }
            limit: 1
          ) {
            items {
              id
              requestId
              name
              cid
              topic
              contentPreview
              blockTimestamp
            }
          }
        }
      `
      
      const recognitionResponse = await request<{
        artifacts: { items: Array<{ cid: string; contentPreview?: string }> }
      }>(PONDER_URL, GET_RECOGNITION_ARTIFACT, { requestId })

      if (recognitionResponse.artifacts.items.length > 0) {
        const recognitionCid = recognitionResponse.artifacts.items[0].cid
        const rawRecognition = await fetchIpfsContent(recognitionCid)
        
        if (rawRecognition) {
          recognitionData = {
            searchQuery: rawRecognition.searchQuery as string,
            similarJobs: rawRecognition.similarJobs as Array<{ requestId: string; score: number; jobName?: string }>,
            learnings: rawRecognition.learnings as string,
            initialSituation: rawRecognition.initialSituation as Record<string, unknown>,
            embeddingStatus: rawRecognition.embeddingStatus as string,
            progressCheckpoint: rawRecognition.progressCheckpoint as RecognitionData['progressCheckpoint']
          }
          console.log('[API] Found recognition data in RECOGNITION_RESULT artifact')
        }
      }
    }

    // FALLBACK 2: Fetch SITUATION artifact (for backward compatibility)
    const situationResponse = await request<{
      artifacts: { items: Array<{ cid: string; contentPreview?: string }> }
    }>(PONDER_URL, GET_SITUATION_ARTIFACT, { requestId })

    if (situationResponse.artifacts.items.length > 0) {
      const situationCid = situationResponse.artifacts.items[0].cid
      const rawSituation = await fetchIpfsContent(situationCid)
      
      // The IPFS content is wrapped in a {content, mimeType, name, topic, type} structure
      // The actual situation data is in the content field as a JSON string
      if (rawSituation && rawSituation.content) {
        try {
          const contentStr = typeof rawSituation.content === 'string' 
            ? rawSituation.content 
            : JSON.stringify(rawSituation.content)
          situationData = JSON.parse(contentStr)
        } catch (e) {
          console.error('[API] Error parsing situation content:', e)
          situationData = rawSituation
        }
      } else {
        situationData = rawSituation
      }

      // FALLBACK 3: Extract recognition data from situation.meta.recognition if we didn't get it from delivery or RECOGNITION_RESULT
      if (!recognitionData && situationData?.meta?.recognition) {
        recognitionData = {
          searchQuery: situationData.meta.recognition.searchQuery,
          similarJobs: situationData.meta.recognition.similarJobs || [],
          learnings: situationData.meta.recognition.markdown || situationData.meta.recognition.learnings,
          initialSituation: situationData.meta.recognition.initialSituation,
          embeddingStatus: situationData.meta.recognition.embeddingStatus,
          progressCheckpoint: situationData.meta.recognition.progressCheckpoint,
          timestamp: situationData.meta.generatedAt
        }
        console.log('[API] Using fallback recognition data from SITUATION artifact')
      }
    }

    return NextResponse.json({
      requestId,
      situation: situationData,
      recognition: recognitionData,
      reflection: reflectionData,
      hasSituation: !!situationData,
      hasRecognition: !!recognitionData,
      hasReflection: !!reflectionData
    })
  } catch (error) {
    console.error('[API] Error fetching memory inspection data:', error)
    return NextResponse.json(
      { 
        error: 'Failed to fetch memory data',
        details: error instanceof Error ? error.message : String(error)
      },
      { status: 500 }
    )
  }
}
