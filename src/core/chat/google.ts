import type { ChatMessage, ChatResult, ProviderPart, ToolCall, Usage } from '../types.js';
import { googleThinkingControl } from '../effort.js';
import { SurfError } from '../errors.js';
import type { ChatRequest } from './types.js';
import {
  DEFAULT_IDLE_TIMEOUT,
  DEFAULT_RESPONSE_TIMEOUT,
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
  const responseTimeout =
    options.responseTimeout ?? provider.settings.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT;
  const idleTimeout = options.idleTimeout ?? provider.settings.idleTimeout ?? DEFAULT_IDLE_TIMEOUT;
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
    retryBaseDelay(provider.settings),
    responseTimeout
  );

  const providerParts: ProviderPart[] = [];
  let signed = false;

  for await (const event of readSse(response, idleTimeout, signal)) {
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
        const hasText = typeof part.text === 'string';
        const text = hasText ? part.text : '';
        // Gemini 3 may attach a thought signature to an empty text part, so
        // capture it before looking at the text. Dropping it breaks the next
        // tool step with a 400 that reads "missing a thought_signature".
        const signature =
          typeof part.thoughtSignature === 'string'
            ? part.thoughtSignature
            : typeof part.functionCall?.thoughtSignature === 'string'
              ? part.functionCall.thoughtSignature
              : undefined;
        if (text) {
          if (part.thought === true) {
            result.reasoning += text;
            callbacks.onReasoning(text);
          } else {
            result.text += text;
            callbacks.onText(text);
          }
        }

        const exact: ProviderPart = {
          // Preserve empty text when it carried the signature: the provider
          // should receive the same part shape on the next tool step.
          ...(hasText ? { text } : {}),
          ...(part.thought === true ? { thought: true } : {}),
          ...(signature ? { thoughtSignature: signature } : {})
        };
        if (part.functionCall?.name) {
          const call: ToolCall = {
            id: part.functionCall.id || generateToolCallId('gcall'),
            name: part.functionCall.name,
            arguments:
              part.functionCall.args && typeof part.functionCall.args === 'object'
                ? (part.functionCall.args as Record<string, unknown>)
                : {},
            signature
          };
          result.toolCalls.push(call);
          exact.functionCall = { name: call.name, args: call.arguments };
        }
        if (Object.keys(exact).length > 0) {
          providerParts.push(exact);
          if (signature) signed = true;
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

  if (signed && providerParts.length > 0) result.providerParts = providerParts;
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

    // Replay exact parts when they carry Gemini thought signatures. The
    // signature can sit on an empty text part, so rebuilding from text and
    // tool calls is not equivalent.
    const exact = (message.providerParts ?? [])
      .map((part) => {
        const output: Record<string, unknown> = {};
        if (part.text !== undefined) output.text = part.text;
        if (part.thought) output.thought = true;
        if (part.functionCall) {
          output.functionCall = {
            name: part.functionCall.name,
            args: part.functionCall.args
          };
        }
        if (part.thoughtSignature) output.thoughtSignature = part.thoughtSignature;
        return output;
      })
      .filter((part) => Object.keys(part).length > 0);
    if (exact.length > 0) {
      contents.push({ role: 'model', parts: exact });
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
