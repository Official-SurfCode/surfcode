import { SurfError } from '../errors.js';
import type { ChatResult, ChatMessage, Effort, ToolSchema, Usage } from '../types.js';

export interface StreamCallbacks {
  onText(delta: string): void;
  onReasoning(delta: string): void;
}

export interface StreamOptions {
  signal: AbortSignal;
  maxTokens: number;
  temperature?: number;
  /** Requested reasoning effort; dialects map it to their native control. */
  effort?: Effort;
  /** Ask providers that support summaries to return reasoning text. */
  showReasoning?: boolean;
  timeout?: number;
}

export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
// 429 is deliberately absent: quota/rate-limit responses will not succeed by
// waiting a few seconds, and retrying them made provider errors feel silent.
export const RETRYABLE_STATUS = new Set([408, 409, 425, 500, 502, 503, 504]);

export function requestSignal(options: StreamOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeout ?? DEFAULT_TIMEOUT);
  return AbortSignal.any([options.signal, timeout]);
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  attempts = 3,
  baseDelay = 600
): Promise<Response> {
  let lastError: unknown;
  const tries = Math.max(1, attempts);
  for (let attempt = 0; attempt < tries; attempt += 1) {
    if (signal.aborted) throw signal.reason ?? new Error('Aborted');
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      if (attempt === tries - 1) break;
      await sleepWithSignal(backoffMs(attempt, baseDelay), signal);
      continue;
    }

    if (response.ok) return response;
    if (!RETRYABLE_STATUS.has(response.status) || attempt === tries - 1) {
      await throwResponseError(response);
    }

    const wait = retryAfterMs(response.headers.get('retry-after')) ?? backoffMs(attempt, baseDelay);
    await response.body?.cancel();
    await sleepWithSignal(Math.min(wait, 30_000), signal);
  }
  throw new SurfError(`Request failed: ${errorText(lastError)}`, {
    hint: 'Check your network connection and provider status.',
    cause: lastError,
    retryable: true
  });
}

export async function throwResponseError(response: Response): Promise<never> {
  let body = '';
  try {
    body = (await response.text()).slice(0, 4_000);
  } catch {
    // Ignore body read errors.
  }
  let message = body.trim();
  try {
    const parsed = JSON.parse(body) as any;
    message =
      parsed?.error?.message ??
      parsed?.error?.toString?.() ??
      parsed?.message ??
      parsed?.detail ??
      parsed?.errors?.[0]?.message ??
      message;
  } catch {
    // Keep raw body.
  }
  const status = response.status;
  const quota =
    status === 429 &&
    /quota|resource_exhausted|rate.?limit|billing|exceeded/i.test(`${message} ${response.statusText}`);
  // Some providers return whole paragraphs (and even HTML) for quota errors.
  // Keep the first useful sentence so one failure does not flood the timeline.
  message = compactErrorText(message);
  let hint: string | undefined;
  if (status === 401 || status === 403) hint = 'Your API key may be invalid or lack access. Run `surf auth <provider>`.';
  if (status === 404) hint = 'The model or endpoint may not exist. Check /model or your baseURL.';
  if (status === 429) {
    hint = quota
      ? 'Quota or rate limit reached. Switch models with /model, or check the provider billing/quota.'
      : 'Rate limited. Switch models with /model, then try again.';
  }
  if (status >= 500) hint = 'The provider had a server error. Try again or switch models.';
  throw new SurfError(`${response.status} ${response.statusText}${message ? ` — ${message}` : ''}`, {
    hint,
    status,
    retryable: RETRYABLE_STATUS.has(status)
  });
}

export async function* readSse(
  response: Response
): AsyncGenerator<{ event?: string; data: string }, void, unknown> {
  if (!response.body) throw new SurfError('Provider returned an empty response body.');
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  for await (const chunk of response.body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line === '') {
        if (data.length > 0) {
          yield { event, data: data.join('\n') };
          data = [];
        }
        event = undefined;
      } else if (line.startsWith(':')) {
        // comment / keepalive
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart());
      }
      newline = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
  if (data.length > 0) yield { event, data: data.join('\n') };
}

export function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export function generateToolCallId(prefix = 'call'): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function parseToolArguments(raw: string | undefined, value?: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (!raw?.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Leave rawArguments for the agent to report.
  }
  return {};
}

export function emptyResult(): ChatResult {
  return { text: '', reasoning: '', toolCalls: [], usage: {} };
}

export function usageFromOpenAi(usage: any): Partial<Usage> {
  if (!usage || typeof usage !== 'object') return {};
  const input = tokenNumber(
    usage.prompt_tokens ??
      usage.input_tokens ??
      usage.total_input_tokens ??
      usage.prompt_tokens_total
  );
  const output = tokenNumber(
    usage.completion_tokens ??
      usage.output_tokens ??
      usage.total_output_tokens ??
      usage.completion_tokens_total
  );
  const cached = tokenNumber(
    usage.prompt_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cached_tokens ??
      usage.input_tokens_details?.cache_read_tokens ??
      usage.prompt_cache_hit_tokens ??
      usage.cache_read_input_tokens ??
      usage.cached_tokens
  );
  const cacheWrite = tokenNumber(
    usage.prompt_tokens_details?.cache_creation_tokens ??
      usage.input_tokens_details?.cache_write_tokens ??
      usage.cache_creation_input_tokens
  );
  const reasoning = tokenNumber(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoning_tokens
  );
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cacheReadTokens: cached } : {}),
    ...(cacheWrite !== undefined ? { cacheWriteTokens: cacheWrite } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {})
  };
}

/** Usage fields arrive cumulatively; never let a late sparse chunk erase a prior value. */
export function mergeUsage(base: Partial<Usage>, patch: Partial<Usage>): Partial<Usage> {
  for (const key of [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cost',
    'requests'
  ] as const) {
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    base[key] = Math.max(base[key] ?? 0, value);
  }
  return base;
}

export function isRetryableError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof SurfError) {
    if (error.retryable !== undefined) return error.retryable;
    if (error.status !== undefined) return RETRYABLE_STATUS.has(error.status);
  }
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  return true;
}

export async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new Error('Aborted');
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('Aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function toolCallFromDelta(
  calls: Map<number, { id: string; name: string; raw: string }>,
  entry: any,
  indexFallback = 0
): void {
  const index = Number.isInteger(entry?.index) ? entry.index : indexFallback;
  const current = calls.get(index) ?? { id: '', name: '', raw: '' };
  if (typeof entry?.id === 'string' && entry.id) current.id = entry.id;
  const fn = entry?.function ?? entry;
  if (typeof fn?.name === 'string' && fn.name) current.name = current.name ? current.name + fn.name : fn.name;
  const args = fn?.arguments;
  if (typeof args === 'string') current.raw += args;
  else if (args && typeof args === 'object') current.raw = JSON.stringify(args);
  calls.set(index, current);
}

export function thinkingText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const item = entry as any;
          return item.text ?? item.content ?? '';
        }
        return '';
      })
      .join('');
  }
  if (value && typeof value === 'object') {
    const item = value as any;
    return item.text ?? item.content ?? '';
  }
  return '';
}

export function textContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const item = part as any;
          return item.text ?? item.content ?? '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

export function messageText(message: ChatMessage): string {
  return message.role === 'tool' ? message.content : message.content;
}

export function baseHeaders(extra: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'cache-control': 'no-cache',
    'user-agent': 'surfcode/0.1',
    ...extra
  };
}

export function streamHeaders(
  headers: Record<string, string>,
  idempotencyKey?: string
): Record<string, string> {
  return {
    ...headers,
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  };
}

export function retryAttempts(settings: { retries?: number } | undefined): number {
  return Math.max(1, Math.min(11, (settings?.retries ?? 2) + 1));
}

export function retryBaseDelay(settings: { retryDelay?: number } | undefined): number {
  return Math.max(0, Math.min(60_000, settings?.retryDelay ?? 600));
}

export function sanitizeToolSchemas(tools: ToolSchema[]): ToolSchema[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  }));
}

function backoffMs(attempt: number, baseDelay: number): number {
  const exponential = Math.max(0, baseDelay) * 2 ** attempt;
  const jitter = 0.85 + Math.random() * 0.3;
  return Math.round(Math.min(30_000, exponential * jitter));
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function tokenNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function compactErrorText(value: string, limit = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) return compact;
  const window = compact.slice(0, limit);
  const sentence = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('! '),
    window.lastIndexOf('? ')
  );
  const cut =
    sentence >= Math.floor(limit * 0.45)
      ? sentence + 1
      : Math.max(0, window.lastIndexOf(' '));
  return `${(cut > 0 ? compact.slice(0, cut) : window).trimEnd()}…`;
}

function errorText(error: unknown): string {
  if (!error) return 'unknown error';
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return 'request timed out';
    return error.message;
  }
  return String(error);
}
