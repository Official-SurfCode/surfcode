import type { ChatMessage, ChatResult, ToolCall, Usage } from '../types.js';
import { googleThinkingControl } from '../effort.js';
import { SurfError } from '../errors.js';
import type { ChatRequest } from './types.js';
import {
  baseHeaders,
  emptyResult,
  fetchWithRetry,
  generateToolCallId,
  mergeUsage,
  readSse,
  requestSignal,
  retryAttempts,
  retryBaseDelay,
  streamHeaders
} from './common.js';

export async function streamGoogle(request: ChatRequest): Promise<ChatResult> {
  const { provider, model, options, callbacks } = request;
  const result = emptyResult();
  const signal = requestSignal(options);
  const thinking =
    options.effort && model.meta?.reasoning === true
      ? googleThinkingControl(model.id, options.effort, options.maxTokens)
      : undefined;
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: options.maxTokens,
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(thinking !== undefined
      ? {
          thinkingConfig: {
            ...thinking,
            // Thought summaries cost bandwidth and rendering work. Only ask
            // for them when the user explicitly wants reasoning visible.
            ...(options.showReasoning ? { includeThoughts: true } : {})
          }
        }
      : {})
  };
  const body: Record<string, unknown> = {
    ...(provider.settings.extraBody ?? {}),
    contents: toGoogleContents(request.messages),
    generationConfig
  };
  if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
  if (request.tools.length > 0 && model.meta?.tool_call !== false) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: cleanSchema(tool.parameters)
        }))
      }
    ];
  }

  const url = googleStreamUrl(provider.baseURL, model.id);
  const response = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: baseHeaders(streamHeaders(provider.headers, request.idempotencyKey)),
      body: JSON.stringify(body)
    },
    signal,
    retryAttempts(provider.settings),
    retryBaseDelay(provider.settings)
  );

  for await (const event of readSse(response)) {
    const payload = parseJson(event.data);
    if (!payload) continue;
    if (payload.error) {
      throw new SurfError(`${provider.name}: ${payload.error.message ?? 'stream error'}`, {
        hint: payload.error.status ? `Provider error status: ${payload.error.status}` : undefined,
        retryable: false
      });
    }
    if (payload.promptFeedback?.blockReason) {
      throw new SurfError(`Request blocked by ${provider.name}: ${payload.promptFeedback.blockReason}`, {
        hint: 'Rephrase the prompt or adjust the provider safety settings.',
        retryable: false
      });
    }

    const candidate = payload.candidates?.[0];
    if (candidate?.content?.parts) {
      for (const part of candidate.content.parts) {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text) {
          if (part.thought === true) {
            result.reasoning += text;
            callbacks.onReasoning(text);
          } else {
            result.text += text;
            callbacks.onText(text);
          }
        }
        if (part.functionCall?.name) {
          const call: ToolCall = {
            id: part.functionCall.id || generateToolCallId('gcall'),
            name: part.functionCall.name,
            arguments:
              part.functionCall.args && typeof part.functionCall.args === 'object'
                ? (part.functionCall.args as Record<string, unknown>)
                : {},
            signature: part.thoughtSignature || part.functionCall.thoughtSignature
          };
          result.toolCalls.push(call);
        }
      }
    }
    if (candidate?.finishReason) result.finishReason = candidate.finishReason;

    const usage = payload.usageMetadata;
    if (usage) {
      const parsed: Partial<Usage> = {
        inputTokens: Number(usage.promptTokenCount ?? 0),
        outputTokens: Number(usage.candidatesTokenCount ?? 0),
        reasoningTokens: Number(usage.thoughtsTokenCount ?? 0),
        cacheReadTokens: Number(usage.cachedContentTokenCount ?? 0)
      };
      result.usage = mergeUsage(result.usage, parsed);
    }
  }

  return result;
}

function toGoogleContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  let functionResponses: Array<Record<string, unknown>> = [];

  const flushResponses = () => {
    if (functionResponses.length > 0) {
      contents.push({ role: 'user', parts: functionResponses });
      functionResponses = [];
    }
  };

  for (const message of messages) {
    if (message.role === 'tool') {
      functionResponses.push({
        functionResponse: {
          name: message.name,
          response: message.isError ? { error: message.content } : { result: message.content }
        }
      });
      continue;
    }
    flushResponses();

    if (message.role === 'user') {
      if (message.content) contents.push({ role: 'user', parts: [{ text: message.content }] });
      continue;
    }

    const parts: Array<Record<string, unknown>> = [];
    if (message.content) parts.push({ text: message.content });
    for (const call of message.toolCalls ?? []) {
      parts.push({
        functionCall: { name: call.name, args: call.arguments },
        ...(call.signature ? { thoughtSignature: call.signature } : {})
      });
    }
    if (parts.length > 0) contents.push({ role: 'model', parts });
  }
  flushResponses();
  return contents;
}

function googleStreamUrl(baseURL: string, modelId: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (/:streamGenerateContent/.test(base)) return base;
  if (/\/models$/.test(base)) return `${base}/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  return `${base}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
}

export function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$schema' || key === 'additionalProperties' || key === 'strict') continue;
    if (key === 'type' && typeof entry === 'string') {
      output.type = entry.toUpperCase();
      continue;
    }
    output[key] = cleanSchema(entry);
  }
  return output;
}

function parseJson(value: string): any | undefined {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
