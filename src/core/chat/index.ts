import { randomUUID } from 'node:crypto';
import type { ChatResult } from '../types.js';
import type { ChatRequest } from './types.js';
import { streamOpenAi } from './openai.js';
import { streamAnthropic } from './anthropic.js';
import { streamGoogle } from './google.js';
import { isAbortError } from '../errors.js';
import { isRetryableError, retryBaseDelay, sleepWithSignal } from './common.js';

/**
 * Stream a chat completion with one transparent retry layer.
 *
 * The HTTP layer already retries before a response body is consumed. This
 * wrapper covers the remaining failure mode: a connection that disappears
 * after headers but before the provider has emitted any content. Once text or
 * reasoning reaches the UI we never replay the request, because that would
 * duplicate tokens on screen and in the conversation.
 */
export async function streamChat(request: ChatRequest): Promise<ChatResult> {
  const idempotencyKey = request.idempotencyKey ?? randomUUID();
  const retries = Math.max(0, Math.min(5, request.provider.settings.retries ?? 2));
  const baseDelay = retryBaseDelay(request.provider.settings);
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let emitted = false;
    try {
      return await streamChatOnce({
        ...request,
        idempotencyKey,
        callbacks: {
          onText: (delta) => {
            emitted = true;
            request.callbacks.onText(delta);
          },
          onReasoning: (delta) => {
            emitted = true;
            request.callbacks.onReasoning(delta);
          }
        }
      });
    } catch (error) {
      lastError = error;
      if (
        request.options.signal.aborted ||
        isAbortError(error) ||
        emitted ||
        attempt === retries ||
        !isRetryableError(error)
      ) {
        throw error;
      }
      await sleepWithSignal(
        Math.round(baseDelay * 2 ** attempt * (0.85 + Math.random() * 0.3)),
        request.options.signal
      );
    }
  }

  throw lastError;
}

async function streamChatOnce(request: ChatRequest): Promise<ChatResult> {
  switch (request.provider.dialect) {
    case 'openai':
      return streamOpenAi(request);
    case 'anthropic':
      return streamAnthropic(request);
    case 'google':
    case 'google-vertex':
      return streamGoogle(request);
    case 'azure':
      return streamOpenAi(request, azureChatUrl(request));
    default:
      throw new Error(`Unsupported provider dialect: ${(request.provider as any).dialect}`);
  }
}

export function azureChatUrl(request: ChatRequest): string {
  const base = request.provider.baseURL.replace(/\/+$/, '');
  const apiVersion = request.provider.settings.apiVersion || '2024-10-21';
  if (/\/chat\/completions/.test(base)) {
    if (/[?&]api-version=/.test(base)) return base;
    return `${base}${base.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(apiVersion)}`;
  }
  const deployment = request.provider.settings.deployment || request.model.id;
  const root = /\/openai$/.test(base) ? base : `${base}/openai`;
  return `${root}/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
}
