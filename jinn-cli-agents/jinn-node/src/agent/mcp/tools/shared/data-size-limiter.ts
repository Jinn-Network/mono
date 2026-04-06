/**
 * Shared utilities for managing data size limits across MCP tools.
 * Optimized for Gemini's 1M token context window with ~600KB safe limit.
 */

export const DEFAULT_SIZE_LIMIT_MB = 0.3; // ~300KB for safer 1M token context window and reduced quota pressure

/**
 * Calculate the size of data in bytes when serialized as JSON
 */
export function calculateDataSize(data: any): number {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
}

/**
 * Convert bytes to megabytes
 */
export function bytesToMB(bytes: number): number {
    return bytes / (1024 * 1024);
}

/**
 * Check if data exceeds the size limit
 */
export function exceedsSizeLimit(data: any, limitMB: number = DEFAULT_SIZE_LIMIT_MB): boolean {
    const sizeBytes = calculateDataSize(data);
    const sizeMB = bytesToMB(sizeBytes);
    return sizeMB > limitMB;
}

/**
 * Get data size in MB for logging/reporting
 */
export function getDataSizeMB(data: any): number {
    const sizeBytes = calculateDataSize(data);
    return bytesToMB(sizeBytes);
}

/**
 * Truncate content to a specified word limit
 */
export function truncateContent(content: string, maxWords: number = 200): string {
    if (!content) return '';
    
    const words = content.trim().split(/\s+/);
    if (words.length <= maxWords) return content;
    
    return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Options for data size enforcement
 */
export interface DataSizeOptions {
    maxSizeMB?: number;
    maxAttempts?: number;
    logPrefix?: string;
    onSizeExceeded?: (currentSizeMB: number, maxSizeMB: number, attempt: number) => void;
}

/**
 * Enforce data size limits with retry logic
 * @param dataFetcher Function that fetches data, should accept a reduction factor (0.5, 0.25, etc.)
 * @param options Configuration options
 * @returns The data that fits within size limits
 */
export async function enforceDataSizeLimit<T>(
    dataFetcher: (reductionFactor: number) => Promise<T>,
    options: DataSizeOptions = {}
): Promise<T> {
    const {
        maxSizeMB = DEFAULT_SIZE_LIMIT_MB,
        maxAttempts = 4,
        logPrefix = 'Data size check',
        onSizeExceeded
    } = options;

    let reductionFactor = 1.0;
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;
        
        const data = await dataFetcher(reductionFactor);
        const dataSizeMB = getDataSizeMB(data);
        
        if (dataSizeMB <= maxSizeMB) {
            return data;
        }
        
        // Data too large, reduce by half and try again
        reductionFactor = Math.max(0.125, reductionFactor / 2); // Minimum 1/8th
        
        if (onSizeExceeded) {
            onSizeExceeded(dataSizeMB, maxSizeMB, attempts);
        }
        
    }
    
    throw new Error(`Unable to fetch data within size limit of ${maxSizeMB}MB even with minimum reduction factor`);
}