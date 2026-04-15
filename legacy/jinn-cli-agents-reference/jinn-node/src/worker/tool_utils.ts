export function safeParseToolResponse(response: any): { ok: boolean; data: any; message?: string } {
  try {
    const text = response?.content?.[0]?.text;
    if (!text) {
      return { ok: false, data: null, message: 'No content' };
    }

    const parsed = JSON.parse(text);
    if (parsed?.meta && typeof parsed.meta.ok === 'boolean') {
      return { ok: parsed.meta.ok, data: parsed.data, message: parsed.meta.message };
    }

    return { ok: true, data: parsed };
  } catch (error: any) {
    return {
      ok: false,
      data: null,
      message: error?.message || String(error),
    };
  }
}
