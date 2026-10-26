import type { CatalogModel, ChatMessage, Dialect, Usage } from './types.js';

export function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    requests: 0
  };
}

export function addUsage(total: Usage, delta: Partial<Usage>): Usage {
  for (const key of [
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'cost',
    'requests'
  ] as const) {
    total[key] = (total[key] ?? 0) + (delta[key] ?? 0);
  }
  return total;
}

export function costForUsage(meta: CatalogModel | undefined, usage: Partial<Usage>, dialect: Dialect): number {
  const cost = meta?.cost;
  if (!cost) return 0;
  const perMillion = 1_000_000;
  const inputRate = Number(cost.input ?? 0);
  const outputRate = Number(cost.output ?? 0);
  const cacheReadRate = Number(cost.cache_read ?? inputRate);
  const cacheWriteRate = Number(cost.cache_write ?? inputRate);
  const reasoningRate = Number(cost.reasoning ?? outputRate);
  const input = Number(usage.inputTokens ?? 0);
  const output = Number(usage.outputTokens ?? 0);
  const reasoning = Number(usage.reasoningTokens ?? 0);
  const cacheRead = Number(usage.cacheReadTokens ?? 0);
  const cacheWrite = Number(usage.cacheWriteTokens ?? 0);

  // Anthropic reports non-cached input in input_tokens and bills cached input
  // separately. OpenAI-compatible APIs and Google report total prompt tokens,
  // so cached tokens must be subtracted before applying the input rate.
  if (dialect === 'anthropic') {
    // Anthropic's output_tokens already includes thinking tokens.
    return (
      (input * inputRate +
        output * outputRate +
        cacheRead * cacheReadRate +
        cacheWrite * cacheWriteRate) /
      perMillion
    );
  }

  // Gemini reports thinking tokens separately from candidatesTokenCount.
  // OpenAI-compatible APIs already include reasoning inside completion_tokens.
  const isGoogle = dialect === 'google' || dialect === 'google-vertex';
  const billableInput = Math.max(0, input - cacheRead - cacheWrite);
  const outputCost = output * outputRate + (isGoogle ? reasoning * reasoningRate : 0);
  return (
    (billableInput * inputRate + outputCost + cacheRead * cacheReadRate + cacheWrite * cacheWriteRate) /
    perMillion
  );
}

export function estimateTokens(value: string): number {
  if (!value) return 0;
  // A deliberately conservative approximation that works across providers.
  let ascii = 0;
  let other = 0;
  for (const char of value) {
    if (char.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3.7 + other / 1.6);
}

export function estimateMessageTokens(message: ChatMessage): number {
  if (message.role === 'tool') return estimateTokens(message.content) + 8;
  if (message.role === 'user') return estimateTokens(message.content) + 6;
  let total = estimateTokens(message.content) + estimateTokens(message.reasoning ?? '') + 8;
  for (const call of message.toolCalls ?? []) {
    total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.arguments)) + 12;
  }
  return total;
}

export function estimateContextTokens(messages: ChatMessage[], system: string): number {
  let total = estimateTokens(system) + 20;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
}

export function formatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.0001) return `$${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0')}`;
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function formatPrice(model: CatalogModel | undefined): string {
  if (!model?.cost?.input && !model?.cost?.output) return 'free';
  const input = Number(model.cost.input ?? 0);
  const output = Number(model.cost.output ?? 0);
  return `$${formatRate(input)} / $${formatRate(output)} per Mtok`;
}

function formatRate(value: number): string {
  if (value === 0) return '0';
  if (value < 0.01) return value.toFixed(3);
  if (value < 1) return value.toFixed(2);
  return value.toFixed(value % 1 === 0 ? 0 : 2);
}
