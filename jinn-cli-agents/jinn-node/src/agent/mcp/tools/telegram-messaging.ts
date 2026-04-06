/**
 * Telegram Messaging MCP Tools
 *
 * Provides tools for AI agents to send and read messages on Telegram.
 * Chat ID and default Topic ID are configured via environment variables.
 * Per-message topic_id can override the default for forum thread targeting.
 *
 * Environment variables:
 * - JINN_JOB_TELEGRAM_CHAT_ID: Target chat ID (group, channel, or user)
 * - JINN_JOB_TELEGRAM_TOPIC_ID: (Optional) Forum topic/thread ID for supergroups
 */

import { z } from 'zod';
import { getCredential } from '../../shared/credential-client.js';

// ============================================
// Schema Definitions
// ============================================

export const telegramSendMessageParams = z.object({
    text: z.string().min(1).max(4096).describe('Message text to send (max 4096 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Text formatting mode (optional)'),
    disable_notification: z.boolean().optional()
        .describe('Send silently without notification (optional)'),
    topic_id: z.number().optional()
        .describe('Forum topic/thread ID. Overrides the default TELEGRAM_TOPIC_ID when targeting a specific thread.'),
});

export const telegramSendMessageSchema = {
    description: `Send a text message to the configured Telegram chat.

FORMATTING (set parse_mode: 'HTML' to enable):
- Bold: <b>text</b>
- Italic: <i>text</i>
- Code: <code>text</code>
- Link: <a href="url">text</a>
- Pre: <pre>block</pre>

Without parse_mode, text is sent as plain (no escaping needed).

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendMessageParams.shape,
};

export const telegramSendPhotoParams = z.object({
    photo: z.string().min(1).describe('Photo URL or file_id to send'),
    caption: z.string().max(1024).optional().describe('Photo caption (max 1024 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Caption formatting mode (optional)'),
    topic_id: z.number().optional()
        .describe('Forum topic/thread ID. Overrides the default TELEGRAM_TOPIC_ID when targeting a specific thread.'),
});

export const telegramSendPhotoSchema = {
    description: `Send a photo to the configured Telegram chat.

Photo can be a URL or file_id from previous upload.

CAPTION FORMATTING (set parse_mode: 'HTML'):
<b>bold</b> <i>italic</i> <code>code</code> <a href="url">link</a>

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendPhotoParams.shape,
};

export const telegramSendDocumentParams = z.object({
    document: z.string().min(1).describe('Document URL or file_id to send'),
    caption: z.string().max(1024).optional().describe('Document caption (max 1024 chars)'),
    parse_mode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Caption formatting mode (optional)'),
    topic_id: z.number().optional()
        .describe('Forum topic/thread ID. Overrides the default TELEGRAM_TOPIC_ID when targeting a specific thread.'),
});

export const telegramSendDocumentSchema = {
    description: `Send a document to the configured Telegram chat.

Document can be a URL or file_id from previous upload.

CAPTION FORMATTING (set parse_mode: 'HTML'):
<b>bold</b> <i>italic</i> <code>code</code> <a href="url">link</a>

Returns: { message_id, chat_id, date } on success`,
    inputSchema: telegramSendDocumentParams.shape,
};

// ============================================
// Helper Functions
// ============================================

async function getTelegramConfig() {
    const botToken = await getCredential('telegram');
    const chatId = process.env.JINN_JOB_TELEGRAM_CHAT_ID;
    const topicIdRaw = process.env.JINN_JOB_TELEGRAM_TOPIC_ID;

    if (!chatId) {
        throw new Error('Missing required environment variable: JINN_JOB_TELEGRAM_CHAT_ID');
    }

    // Parse topic ID as number if provided
    const topicId = topicIdRaw ? parseInt(topicIdRaw, 10) : undefined;

    return { botToken, chatId, topicId };
}

async function telegramApiCall<T>(
    method: string,
    botToken: string,
    params: Record<string, unknown>
): Promise<T> {
    const url = `https://api.telegram.org/bot${botToken}/${method}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    const data = await response.json() as { ok: boolean; result?: T; description?: string };

    if (!data.ok) {
        throw new Error(`Telegram API error: ${data.description || 'Unknown error'}`);
    }

    return data.result as T;
}

// ============================================
// Tool Implementations
// ============================================

interface TelegramMessage {
    message_id: number;
    chat: { id: number; title?: string; type: string };
    date: number;
    text?: string;
}

export async function telegramSendMessage(args: unknown) {
    try {
        const parsed = telegramSendMessageParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { text, parse_mode, disable_notification, topic_id } = parsed.data;
        const effectiveTopicId = topic_id ?? config.topicId;

        const result = await telegramApiCall<TelegramMessage>('sendMessage', config.botToken, {
            chat_id: config.chatId,
            text,
            ...(effectiveTopicId && { message_thread_id: effectiveTopicId }),
            ...(parse_mode && { parse_mode }),
            ...(disable_notification && { disable_notification }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}

export async function telegramSendPhoto(args: unknown) {
    try {
        const parsed = telegramSendPhotoParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { photo, caption, parse_mode, topic_id } = parsed.data;
        const effectiveTopicId = topic_id ?? config.topicId;

        const result = await telegramApiCall<TelegramMessage>('sendPhoto', config.botToken, {
            chat_id: config.chatId,
            photo,
            ...(effectiveTopicId && { message_thread_id: effectiveTopicId }),
            ...(caption && { caption }),
            ...(parse_mode && { parse_mode }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}

export async function telegramSendDocument(args: unknown) {
    try {
        const parsed = telegramSendDocumentParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { document, caption, parse_mode, topic_id } = parsed.data;
        const effectiveTopicId = topic_id ?? config.topicId;

        const result = await telegramApiCall<TelegramMessage>('sendDocument', config.botToken, {
            chat_id: config.chatId,
            document,
            ...(effectiveTopicId && { message_thread_id: effectiveTopicId }),
            ...(caption && { caption }),
            ...(parse_mode && { parse_mode }),
        });

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: {
                        message_id: result.message_id,
                        chat_id: result.chat.id,
                        date: new Date(result.date * 1000).toISOString(),
                    },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}

// ============================================
// Read Tools
// ============================================

export const telegramGetUpdatesParams = z.object({
    limit: z.number().min(1).max(100).optional()
        .describe('Max updates to retrieve (1–100, default: 20)'),
    offset: z.number().optional()
        .describe('Update ID offset — pass last update_id + 1 to acknowledge previous updates and avoid receiving them again'),
    allowed_updates: z.array(z.string()).optional()
        .describe('Update types to receive, e.g. ["message", "edited_message"]. Default: ["message"]'),
});

export const telegramGetUpdatesSchema = {
    description: `Read recent messages from the configured Telegram chat via long polling.

Use offset to paginate: pass the highest update_id + 1 from the previous call to only receive new updates.
Without offset, returns the earliest unconfirmed updates.

Returns an array of updates, each containing a message with sender info, text, thread ID, and reply context.

Note: The bot only sees messages sent after it was added to the group, and only in threads where it has access.`,
    inputSchema: telegramGetUpdatesParams.shape,
};

interface TelegramUpdate {
    update_id: number;
    message?: {
        message_id: number;
        from?: { id: number; first_name: string; username?: string; is_bot?: boolean };
        chat: { id: number; title?: string; type: string };
        date: number;
        text?: string;
        message_thread_id?: number;
        reply_to_message?: {
            message_id: number;
            text?: string;
            from?: { id: number; first_name: string; username?: string; is_bot?: boolean };
        };
    };
}

export async function telegramGetUpdates(args: unknown) {
    try {
        const parsed = telegramGetUpdatesParams.safeParse(args);
        if (!parsed.success) {
            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        data: null,
                        meta: { ok: false, code: 'VALIDATION_ERROR', message: parsed.error.message },
                    }),
                }],
            };
        }

        const config = await getTelegramConfig();
        const { limit, offset, allowed_updates } = parsed.data;

        const result = await telegramApiCall<TelegramUpdate[]>('getUpdates', config.botToken, {
            ...(limit !== undefined ? { limit } : { limit: 20 }),
            ...(offset !== undefined && { offset }),
            allowed_updates: allowed_updates ?? ['message'],
            timeout: 0, // Short polling — agent controls the cycle
        });

        // Transform updates to a cleaner shape for the agent
        const updates = result.map(update => ({
            update_id: update.update_id,
            ...(update.message && {
                message: {
                    message_id: update.message.message_id,
                    from: update.message.from ? {
                        id: update.message.from.id,
                        first_name: update.message.from.first_name,
                        ...(update.message.from.username && { username: update.message.from.username }),
                        ...(update.message.from.is_bot && { is_bot: update.message.from.is_bot }),
                    } : undefined,
                    chat: {
                        id: update.message.chat.id,
                        ...(update.message.chat.title && { title: update.message.chat.title }),
                        type: update.message.chat.type,
                    },
                    date: new Date(update.message.date * 1000).toISOString(),
                    ...(update.message.text && { text: update.message.text }),
                    ...(update.message.message_thread_id && { message_thread_id: update.message.message_thread_id }),
                    ...(update.message.reply_to_message && {
                        reply_to_message: {
                            message_id: update.message.reply_to_message.message_id,
                            ...(update.message.reply_to_message.text && { text: update.message.reply_to_message.text }),
                            ...(update.message.reply_to_message.from && {
                                from: {
                                    id: update.message.reply_to_message.from.id,
                                    first_name: update.message.reply_to_message.from.first_name,
                                    ...(update.message.reply_to_message.from.username && { username: update.message.reply_to_message.from.username }),
                                },
                            }),
                        },
                    }),
                },
            }),
        }));

        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: { updates },
                    meta: { ok: true },
                }),
            }],
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{
                type: 'text' as const,
                text: JSON.stringify({
                    data: null,
                    meta: { ok: false, code: 'EXECUTION_ERROR', message },
                }),
            }],
        };
    }
}
