export type ExtractedArtifact = {
  cid: string;
  contentCid?: string;
  name?: string;
  topic: string;
  contentPreview?: string;
  content?: string;
  type?: string;
  documentType?: string;
  tags?: string[];
};

function tryParseJson(text: string): any | null {
  try { return JSON.parse(text); } catch { return null; }
}

export function extractArtifactsFromOutput(output: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  if (!output || typeof output !== 'string') return artifacts;

  const candidates: string[] = [];
  let buffer = '';
  let started = false;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < output.length; i++) {
    const ch = output[i];
    if (!started) {
      if (ch === '{') {
        started = true;
        depth = 1;
        buffer = '{';
        inString = false;
        escapeNext = false;
      }
      continue;
    }
    buffer += ch;
    if (escapeNext) {
      escapeNext = false;
    } else if (ch === '\\' && inString) {
      escapeNext = true;
    } else if (ch === '"') {
      inString = !inString;
    } else if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (started && depth === 0) {
      candidates.push(buffer.trim());
      started = false;
      buffer = '';
      inString = false;
      escapeNext = false;
    }
  }

  for (const c of candidates) {
    const obj = tryParseJson(c);
    if (!obj) continue;
    const maybe = obj?.data || obj;
    if (maybe && typeof maybe === 'object' && typeof maybe.cid === 'string' && typeof maybe.topic === 'string') {
      const item: ExtractedArtifact = {
        cid: String(maybe.cid),
        topic: String(maybe.topic),
      };
      if (typeof maybe.name === 'string') item.name = maybe.name;
      if (typeof maybe.contentPreview === 'string') item.contentPreview = maybe.contentPreview;
      if (typeof maybe.type === 'string') item.type = maybe.type;
      if (typeof maybe.contentCid === 'string') item.contentCid = maybe.contentCid;
      if (typeof maybe.documentType === 'string') item.documentType = maybe.documentType;
      if (Array.isArray(maybe.tags)) item.tags = maybe.tags.map((t: any) => String(t));
      artifacts.push(item);
    }
  }
  return artifacts;
}

export function extractArtifactsFromTelemetry(telemetry: any): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];
  if (!telemetry) return artifacts;

  // NEW: Extract artifacts directly from structured tool calls
  // Both create_artifact and create_measurement produce artifacts with cid/topic
  if (Array.isArray(telemetry.toolCalls)) {
    for (const toolCall of telemetry.toolCalls) {
      const isArtifactTool = toolCall.tool === 'create_artifact' || toolCall.tool === 'create_measurement';
      if (isArtifactTool && toolCall.success && toolCall.result) {
        const result = toolCall.result;
        if (result.cid && result.topic) {
          const artifact: ExtractedArtifact = {
            cid: String(result.cid),
            topic: String(result.topic),
          };
          if (result.name) artifact.name = String(result.name);
          if (result.contentPreview) artifact.contentPreview = String(result.contentPreview);
          if (result.type) artifact.type = String(result.type);
          if (result.contentCid) artifact.contentCid = String(result.contentCid);
          if (result.documentType) artifact.documentType = String(result.documentType);
          if (Array.isArray(result.tags)) artifact.tags = result.tags.map((t: any) => String(t));

          artifacts.push(artifact);
        }
      }
    }
  }

  // If we found artifacts from structured tool calls, return them
  if (artifacts.length > 0) {
    return artifacts;
  }

  // FALLBACK: Legacy parsing for backward compatibility
  const texts: string[] = [];

  // Collect all text strings from request and response
  if (Array.isArray(telemetry?.responseText)) {
    for (const t of telemetry.responseText) {
      if (typeof t === 'string') texts.push(t);
    }
  }
  if (Array.isArray(telemetry?.requestText)) {
    for (const t of telemetry.requestText) {
      if (typeof t === 'string') texts.push(t);
    }
  }

  const seen = new Set<string>();

  for (const t of texts) {
    // First try to extract from the text as-is (for backward compatibility with flat structures)
    const flatItems = extractArtifactsFromOutput(t);
    for (const it of flatItems) {
      const key = `${it.cid}|${it.topic}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(it);
    }

    // Then try to parse as JSON and extract from nested Gemini CLI structure
    const nestedItems = extractArtifactsFromNestedStructure(t);
    for (const it of nestedItems) {
      const key = `${it.cid}|${it.topic}`;
      if (seen.has(key)) continue;
      seen.add(key);
      artifacts.push(it);
    }
  }

  return artifacts;
}

function extractArtifactsFromNestedStructure(text: string): ExtractedArtifact[] {
  const artifacts: ExtractedArtifact[] = [];

  try {
    const parsed = JSON.parse(text);

    // Handle Gemini API response structure: candidates[].content.parts[].functionResponse.response.output
    if (parsed.candidates && Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) {
        if (candidate.content && candidate.content.parts && Array.isArray(candidate.content.parts)) {
          for (const part of candidate.content.parts) {
            if (part.functionResponse && part.functionResponse.response && part.functionResponse.response.output) {
              // The output field contains a JSON string that needs to be parsed again
              try {
                const output = JSON.parse(part.functionResponse.response.output);
                const maybe = output?.data || output;

                if (maybe && typeof maybe === 'object' && typeof maybe.cid === 'string' && typeof maybe.topic === 'string') {
                  const item: ExtractedArtifact = {
                    cid: String(maybe.cid),
                    topic: String(maybe.topic),
                  };
                  if (typeof maybe.name === 'string') item.name = maybe.name;
                  if (typeof maybe.contentPreview === 'string') item.contentPreview = maybe.contentPreview;
                  if (typeof maybe.type === 'string') item.type = maybe.type;
                  if (typeof maybe.contentCid === 'string') item.contentCid = maybe.contentCid;
                  if (typeof maybe.documentType === 'string') item.documentType = maybe.documentType;
                  if (Array.isArray(maybe.tags)) item.tags = maybe.tags.map((t: any) => String(t));
                  artifacts.push(item);
                }
              } catch (outputParseError) {
                // If inner JSON parsing fails, skip this part
                continue;
              }
            }
          }
        }
      }
    }
  } catch (parseError) {
    // If outer JSON parsing fails, return empty array (not an error, just not nested structure)
  }

  return artifacts;
}


