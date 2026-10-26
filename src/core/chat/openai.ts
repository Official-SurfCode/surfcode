import type { ChatMessage, ChatResult, ToolCall, Usage } from '../types.js';
import { supportsOpenAiEffort } from '../effort.js';
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
  streamHeaders,
  textContent,
  thinkingText,
  toolCallFromDelta,
  usageFromOpenAi
} from './common.js';

export async function streamOpenAi(request: ChatRequest, endpoint?: string): Promise<ChatResult> {
  const { provider, model, options, callbacks } = request;
  const result = emptyResult();
  const signal = requestSignal(options);
  const body: Record<string, unknown> = {
    ...(provider.settings.extraBody ?? {}),
    model: model.id,
    messages: toOpenAiMessages(request.messages, request.system, provider.id),
    stream: true,
    stream_options: { include_usage: true }
  };

  if (request.tools.length > 0 && model.meta?.tool_call !== false) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }));
    body.tool_choice = 'auto';
  }

  const reasoningModel =
    model.meta?.reasoning === true ||
    ((provider.id === 'openai' || provider.id === 'azure') && /^(o[1-9]|gpt-5)/i.test(model.id));
  const effort =
    options.effort && supportsOpenAiEffort(provider.id) && reasoningModel
      ? options.effort
      : undefined;
  if (effort && provider.id === 'openrouter') {
    body.reasoning = { effort };
  } else if (effort) {
    body.reasoning_effort = effort;
  }

  // Reasoning models reject custom sampling controls on several endpoints.
  if (options.temperature !== undefined && !(effort && reasoningModel)) {
    body.temperature = options.temperature;
  }

  if (options.maxTokens > 0) {
    const useCompletionTokens =
      provider.id === 'openai' && /^(o[1-9]|gpt-5)/i.test(model.id);
    body[useCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = options.maxTokens;
  }

  const url = endpoint ?? chatCompletionsUrl(provider.baseURL);
  const attempts = retryAttempts(provider.settings);
  const delay = retryBaseDelay(provider.settings);
  const init = {
    method: 'POST',
    headers: baseHeaders(streamHeaders(provider.headers, request.idempotencyKey)),
    body: JSON.stringify(body)
  } satisfies RequestInit;
  let response: Response;
  try {
    response = await fetchWithRetry(url, init, signal, attempts, delay);
  } catch (error) {
    // A handful of OpenAI-compatible servers reject stream_options instead of ignoring it.
    if (
      error instanceof SurfError &&
      (error.status === 400 || error.status === 422) &&
      /stream_options|include_usage/i.test(error.message) &&
      'stream_options' in body
    ) {
      delete body.stream_options;
      response = await fetchWithRetry(
        url,
        { ...init, body: JSON.stringify(body) },
        signal,
        attempts,
        delay
      );
    } else {
      throw error;
    }
  }

  const callParts = new Map<number, { id: string; name: string; raw: string }>();
  let usage: Partial<Usage> = {};

  for await (const event of readSse(response)) {
    if (event.data === '[DONE]') break;
    const payload = parseJson(event.data);
    if (!payload) continue;
    if (payload.error) {
      const message = payload.error.message ?? String(payload.error);
      throw new SurfError(`${provider.name}: ${message}`, {
        hint: payload.error.code ? `Provider error code: ${payload.error.code}` : undefined,
        retryable: false
      });
    }

    if (payload.usage) usage = mergeUsage(usage, usageFromOpenAi(payload.usage));

    const choice = payload.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? choice.message ?? {};

    const reasoning = thinkingText(delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text);
    if (reasoning) {
      result.reasoning += reasoning;
      callbacks.onReasoning(reasoning);
    }

    const text = textContent(delta.content ?? delta.text);
    if (text) {
      result.text += text;
      callbacks.onText(text);
    }

    if (Array.isArray(delta.tool_calls)) {
      delta.tool_calls.forEach((entry: any, index: number) => {
        toolCallFromDelta(callParts, entry, Number.isInteger(entry?.index) ? entry.index : index);
      });
    }
    if (delta.function_call) {
      toolCallFromDelta(callParts, { index: 0, function: delta.function_call }, 0);
    }

    if (choice.finish_reason) result.finishReason = choice.finish_reason;
    usage = mergeUsage(usage, usageFromOpenAi(choice.usage));
  }

  result.toolCalls = [...callParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]): ToolCall => ({
      id: call.id || generateToolCallId(),
      name: call.name,
      arguments: parseToolArguments(call.raw),
      rawArguments: call.raw || undefined
    }))
    .filter((call) => call.name.length > 0);

  result.usage = usage;
  return result;
}

export function toOpenAiMessages(
  messages: ChatMessage[],
  system: string,
  providerId?: string
): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  if (system.trim()) output.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'user') {
      output.push({ role: 'user', content: message.content });
    } else if (message.role === 'assistant') {
      const entry: Record<string, unknown> = {
        role: 'assistant',
        content: message.content || null
      };
      if (message.toolCalls?.length) {
        entry.tool_calls = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.arguments) }
        }));
      }
      if (providerId === 'deepseek' && message.reasoning) entry.reasoning_content = message.reasoning;
      output.push(entry);
    } else {
      output.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
    }
  }
  return output;
}

export function chatCompletionsUrl(baseURL: string): string {
  if (/\/chat\/completions\/?$/.test(baseURL)) return baseURL;
  return `${baseURL.replace(/\/+$/, '')}/chat/completions`;
}

function parseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
