import type { Effort, EffortSetting } from './types.js';

export const EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export const EFFORT_SETTINGS = ['auto', ...EFFORT_LEVELS] as const;

const ANTHROPIC_BUDGETS: Record<Effort, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384
};

const GOOGLE_BUDGETS: Record<Effort, number> = {
  low: 1_024,
  medium: 8_192,
  high: 24_576
};

export const EFFORT_GUIDANCE: Record<Effort, string> = {
  low: 'Answer directly. Spend little time deliberating and keep tool use to the minimum needed.',
  medium: 'Balance speed and depth. Reason through the problem, then act.',
  high: 'Think carefully. Explore alternatives, verify assumptions, and check your work before answering.'
};

export function parseEffort(value: string): EffortSetting | undefined {
  const normalized = value.trim().toLowerCase();
  return (EFFORT_SETTINGS as readonly string[]).includes(normalized)
    ? (normalized as EffortSetting)
    : undefined;
}

export function activeEffort(value: EffortSetting | undefined): Effort | undefined {
  return value && value !== 'auto' ? (value as Effort) : undefined;
}

export function effortLabel(value: EffortSetting | undefined): string {
  return !value || value === 'auto' ? 'auto (provider default)' : value;
}

/**
 * Extended-thinking budget for Anthropic. The API requires room for both the
 * thinking block and the final answer, so leave at least 1k tokens for text.
 */
export function anthropicThinkingBudget(
  effort: Effort,
  maxTokens: number
): number | undefined {
  const available = maxTokens - 1_024;
  if (available < 1_024) return undefined;
  return Math.min(ANTHROPIC_BUDGETS[effort], available);
}

/**
 * Gemini counts thinking tokens inside maxOutputTokens. Keep a small reserve
 * so a small output limit cannot make the request invalid.
 */
export function googleThinkingBudget(
  effort: Effort,
  maxTokens: number
): number | undefined {
  const available = maxTokens - 512;
  if (available < 1) return undefined;
  return Math.min(GOOGLE_BUDGETS[effort], available);
}

export type GoogleThinkingControl =
  | { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' }
  | { thinkingBudget: number };

/**
 * Gemini 3 and newer take `thinkingLevel`; Gemini 2.5 takes `thinkingBudget`.
 * Flash-Lite models get `minimal` for low effort, which is their true
 * "no thinking" setting. Gemini 2.5 Flash/Flash-Lite accept a zero budget.
 * Pro models cannot fully disable thinking, so low stays at a small budget.
 */
export function googleThinkingControl(
  modelId: string,
  effort: Effort,
  maxTokens: number
): GoogleThinkingControl | undefined {
  const id = modelId.toLowerCase();
  const match = /gemini-(\d+)(?:\.(\d+))?/.exec(id);
  const major = match ? Number(match[1]) : 0;
  const minor = match?.[2] ? Number(match[2]) : 0;
  const lite = /flash[-_.]?lite|lite/.test(id);
  const pro = /(?:^|[-_/])pro(?:$|[-_/])/.test(id);

  if (major >= 3) {
    const low = lite ? 'minimal' : 'low';
    return { thinkingLevel: effort === 'low' ? low : effort };
  }

  if (major === 2 && minor >= 5) {
    if (effort === 'low' && !pro) return { thinkingBudget: 0 };
    const budget = googleThinkingBudget(effort, maxTokens);
    return budget === undefined ? undefined : { thinkingBudget: budget };
  }

  const budget = googleThinkingBudget(effort, maxTokens);
  return budget === undefined ? undefined : { thinkingBudget: budget };
}

/** Providers whose OpenAI-compatible endpoint understands `reasoning_effort`. */
export function supportsOpenAiEffort(providerId: string): boolean {
  return new Set(['openai', 'azure', 'groq', 'cerebras', 'openrouter']).has(providerId);
}
