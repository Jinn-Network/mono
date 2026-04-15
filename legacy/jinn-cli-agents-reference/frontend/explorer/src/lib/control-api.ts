
const CONTROL_API_URL = process.env.NEXT_PUBLIC_CONTROL_API_URL || 'http://localhost:4001/graphql';

export interface JobReport {
    id: string;
    request_id: string;
    status: string;
    duration_ms: number;
    total_tokens: number;
    final_output: string | null;
    error_message: string | null;
    error_type: string | null;
    created_at: string;
    raw_telemetry: string; // JSON string containing jobInstanceStatusUpdate
}

export async function getJobReport(requestId: string): Promise<JobReport | null> {
    const query = `
    query JobReport($requestId: String!) {
      jobReport(requestId: $requestId) {
        id
        request_id
        status
        duration_ms
        total_tokens
        final_output
        error_message
        error_type
        created_at
        raw_telemetry // This contains the status update
      }
    }
  `;

    try {
        const res = await fetch(CONTROL_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query,
                variables: { requestId }
            })
        });

        if (!res.ok) {
            console.warn('[ControlAPI] Failed to fetch job report:', res.statusText);
            return null;
        }

        const json = await res.json();
        if (json.errors) {
            console.warn('[ControlAPI] GraphQL errors:', json.errors);
            return null;
        }

        return json.data?.jobReport || null;
    } catch (err) {
        console.error('[ControlAPI] Error fetching job report:', err);
        return null;
    }
}
