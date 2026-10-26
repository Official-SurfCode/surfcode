/**
 * Providers with a permanent no-cost API tier.
 *
 * A badge means the provider itself offers free, rate-limited inference; it
 * does not mean every model is free. Trial credits and one-off promotions are
 * deliberately excluded because they expire. Local runtimes are already
 * labelled separately in the UI.
 */
export const FREE_API_PROVIDERS = new Set([
  'google',
  'groq',
  'mistral',
  'openrouter',
  'cloudflare-workers-ai'
]);

export function hasFreeApi(providerId: string): boolean {
  return FREE_API_PROVIDERS.has(providerId);
}

export const FREE_API_LABEL = '[FREE API]';
export const FREE_API_HINT = 'free tier · rate-limited';
