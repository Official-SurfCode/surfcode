import type { ChatMessage, ChatResult, ThinkingBlock, ToolCall, Usage } from '../types.js';
import { anthropicThinkingBudget } from '../effort.js';
import { SurfError } from '../errors.js';
import type { ChatRequest } from './types.js';
import {
  baseHeaders,
  emptyResult,
  fetchWithRetry,
  generateToolCallId,
  mergeUsage,
  parseToolArguments,
  readSse,
  requestSignal,
  retryAttempts,
  retryBaseDelay,
  streamHeaders
} from './common.js';

export async function streamAnthropic(request: ChatRequest): Promise<ChatResult> {
  const { provider, model, options, callbacks } = request;
  const result = emptyResult();
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    ...(provider.settings.extraBody ?? {}),
    model: model.id,
    max_tokens: options.maxTokens,
    system: request.system,
    messages: toAnthropicMessages(request.messages),
    stream: true
  };

  if (request.tools.length > 0 && model.meta?.tool_call !== false) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }
  const thinkingBudget =
    options.effort && model.meta?.reasoning === true
      ? anthropicThinkingBudget(options.effort, options.maxTokens)
      : undefined;
  if (thinkingBudget) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }
  // Extended thinking fixes sampling at the provider default.
  if (options.temperature !== undefined && !thinkingBudget) body.temperature = options.temperature;

  const response = await fetchWithRetry(
    anthropicMessagesUrl(provider.baseURL),
    {
      method: 'POST',
      headers: baseHeaders(streamHeaders(provider.headers, request.idempotencyKey)),
      body: JSON.stringify(body)
    },
    signal,
    retryAttempts(provider.settings),
    retryBaseDelay(provider.settings)
  );

  const blocks = new Map<number, { id: string; name: string; raw: string }>();
  const thinkingBlocks = new Map<number, ThinkingBlock>();
  const usage: Partial<Usage> = {};

  for await (const event of readSse(response)) {
    const payload = parseJson(event.data);
    if (!payload) continue;
    const type = payload.type ?? event.event;

    if (type === 'error') {
      throw new SurfError(`${provider.name}: ${payload.error?.message ?? 'stream error'}`, {
        hint: payload.error?.type ? `Provider error type: ${payload.error.type}` : undefined,
        retryable: false
      });
    }

    if (type === 'message_start') {
      const startUsage = payload.message?.usage ?? {};
      mergeUsage(usage, {
        inputTokens: Number(startUsage.input_tokens ?? 0),
        outputTokens: Number(startUsage.output_tokens ?? 0),
        cacheReadTokens: Number(startUsage.cache_read_input_tokens ?? 0),
        cacheWriteTokens: Number(startUsage.cache_creation_input_tokens ?? 0)
      });
      result.finishReason = payload.message?.stop_reason ?? undefined;
      continue;
    }

    if (type === 'content_block_start') {
      const index = Number(payload.index ?? 0);
      const block = payload.content_block ?? {};
      if (block.type === 'tool_use') {
        blocks.set(index, {
          id: block.id || generateToolCallId(),
          name: block.name || '',
          raw: block.input && Object.keys(block.input).length > 0 ? JSON.stringify(block.input) : ''
        });
      } else if (block.type === 'thinking') {
        const thinking = typeof block.thinking === 'string' ? block.thinking : '';
        thinkingBlocks.set(index, {
          thinking,
          ...(typeof block.signature === 'string' ? { signature: block.signature } : {})
        });
        if (thinking) {
          result.reasoning += thinking;
          callbacks.onReasoning(thinking);
        }
      } else if (block.type === 'redacted_thinking' && typeof block.data === 'string') {
        thinkingBlocks.set(index, { type: 'redacted_thinking', thinking: '', data: block.data });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        result.text += block.text;
        callbacks.onText(block.text);
      }
      continue;
    }

    if (type === 'content_block_delta') {
      const index = Number(payload.index ?? 0);
      const delta = payload.delta ?? {};
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        result.text += delta.text;
        callbacks.onText(delta.text);
      } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        const block = thinkingBlocks.get(index);
        if (block) block.thinking += delta.thinking;
        result.reasoning += delta.thinking;
        callbacks.onReasoning(delta.thinking);
      } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
        const block = thinkingBlocks.get(index);
        if (block) block.signature = delta.signature;
      } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const block = blocks.get(index);
        if (block) block.raw += delta.partial_json;
      }
      continue;
    }

    if (type === 'message_delta') {
      const delta = payload.delta ?? {};
      if (delta.stop_reason) result.finishReason = delta.stop_reason;
      const deltaUsage = payload.usage ?? {};
      mergeUsage(usage, {
        ...(deltaUsage.output_tokens !== undefined
          ? { outputTokens: Number(deltaUsage.output_tokens) }
          : {}),
        ...(deltaUsage.input_tokens !== undefined
          ? { inputTokens: Number(deltaUsage.input_tokens) }
          : {}),
        ...(deltaUsage.cache_read_input_tokens !== undefined
          ? { cacheReadTokens: Number(deltaUsage.cache_read_input_tokens) }
          : {}),
        ...(deltaUsage.cache_creation_input_tokens !== undefined
          ? { cacheWriteTokens: Number(deltaUsage.cache_creation_input_tokens) }
          : {})
      });
    }
  }

  const replayableThinking = [...thinkingBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => block)
    .filter((block) => Boolean(block.data || block.signature));
  if (replayableThinking.length > 0) result.thinkingBlocks = replayableThinking;

  result.toolCalls = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]): ToolCall => ({
      id: block.id,
      name: block.name,
      arguments: parseToolArguments(block.raw),
      rawArguments: block.raw || undefined
    }))
    .filter((call) => call.name.length > 0);

  result.usage = usage;
  return result;
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const turns: Array<Record<string, unknown>> = [];
  let toolResults: Array<Record<string, unknown>> = [];

  const flushToolResults = () => {
    if (toolResults.length > 0) {
      turns.push({ role: 'user', content: toolResults });
      toolResults = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      toolResults.push({
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {})
      });
      continue;
    }
    flushToolResults();

    if (message.role === 'user') {
      if (!message.content) continue;
      turns.push({ role: 'user', content: message.content });
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    for (const block of message.thinkingBlocks ?? []) {
      if (block.type === 'redacted_thinking' && block.data) {
        content.push({ type: 'redacted_thinking', data: block.data });
      } else if (block.signature) {
        content.push({
          type: 'thinking',
          thinking: block.thinking,
          signature: block.signature
        });
      }
    }
    if (message.content) content.push({ type: 'text', text: message.content });
    for (const call of message.toolCalls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
    }
    if (content.length > 0) turns.push({ role: 'assistant', content });
  }
  flushToolResults();
  return turns;
}

function anthropicMessagesUrl(baseURL: string): string {
  if (/\/v1\/messages\/?$/.test(baseURL)) return baseURL;
  if (/\/v1\/?$/.test(baseURL)) return `${baseURL.replace(/\/+$/, '')}/messages`;
  return `${baseURL.replace(/\/+$/, '')}/v1/messages`;
}

function parseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
