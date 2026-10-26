import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import chalk from 'chalk';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import { credentialStatus, type CredentialStatus } from '../core/auth.js';
import {
  bestProviderWithCredential,
  providerHasEndpoint
} from '../core/provider.js';
import {
  findModel,
  recommendedModel,
  scoreModel,
  providerById,
  type Catalog
} from '../core/catalog.js';
import { updateConfig } from '../core/config.js';
import { SurfError } from '../core/errors.js';
import type { CatalogProvider, SurfConfig } from '../core/types.js';
import { formatPrice, formatTokens } from '../core/usage.js';

export const PRIORITY_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'deepseek',
  'xai',
  'mistral',
  'groq',
  'cerebras',
  'togetherai',
  'vercel',
  'github-copilot',
  'azure',
  'amazon-bedrock',
  'google-vertex',
  'moonshotai',
  'zhipuai',
  'alibaba',
  'minimax',
  'cohere',
  'perplexity',
  'fireworks-ai',
  'deepinfra',
  'ollama-cloud'
];

export function write(line = ''): void {
  process.stdout.write(`${line}\n`);
}

export function writeError(line = ''): void {
  process.stderr.write(`${line}\n`);
}

export function accent(text: string): string {
  return chalk.hex('#5EEAD4')(text);
}

export function accent2(text: string): string {
  return chalk.hex('#818CF8')(text);
}

export function muted(text: string): string {
  return chalk.dim(text);
}

export function success(text: string): string {
  return chalk.hex('#4ADE80')(text);
}

export function warning(text: string): string {
  return chalk.hex('#FBBF24')(text);
}

export function danger(text: string): string {
  return chalk.hex('#FB7185')(text);
}

export function title(text: string): string {
  return chalk.bold(chalk.hex('#5EEAD4')(text));
}

export interface TableOptions {
  maxWidth?: number;
  /** Keep the first column intact while narrower columns can still shrink. */
  protectFirst?: boolean;
}

export function table(headers: string[], rows: string[][], options: TableOptions = {}): void {
  if (rows.length === 0) return;
  const terminalWidth = options.maxWidth ?? process.stdout.columns ?? 120;
  const widths = headers.map((header, index) => {
    const values = rows.map((row) => (row[index] ? stringWidth(stripAnsi(row[index]!)) : 0));
    return Math.min(Math.max(stringWidth(header), ...values), 60);
  });
  const separator = '  ';
  const total = widths.reduce((sum, width) => sum + width, 0) + separator.length * (widths.length - 1);
  if (total > terminalWidth) {
    // Shrink the widest columns first. A protected first column is only
    // touched after every other column has reached its minimum width.
    let excess = total - terminalWidth;
    while (excess > 0) {
      let widest = options.protectFirst ? 1 : 0;
      for (let index = widest + 1; index < widths.length; index += 1) {
        if (widths[index]! > widths[widest]!) widest = index;
      }
      if (widths[widest]! > 10) {
        widths[widest] = widths[widest]! - 1;
        excess -= 1;
        continue;
      }
      if (options.protectFirst && widths[0]! > 10) {
        widths[0] = widths[0]! - 1;
        excess -= 1;
        continue;
      }
      break;
    }
  }
  write(headers.map((header, index) => chalk.dim(cell(header, widths[index]!))).join(separator).trimEnd());
  for (const row of rows) {
    write(
      row
        .map((value, index) => cell(value ?? '', widths[index]!))
        .join(separator)
        .trimEnd()
    );
  }
}

export function cell(value: string, width: number): string {
  const text = stringWidth(stripAnsi(value)) > width ? truncateAnsi(value, width) : value;
  const padding = Math.max(0, width - stringWidth(stripAnsi(text)));
  return `${text}${' '.repeat(padding)}`;
}

export function truncateAnsi(value: string, width: number): string {
  if (width <= 0) return '';
  if (stringWidth(stripAnsi(value)) <= width) return value;
  const plain = [...stripAnsi(value)];
  if (plain.length <= width) return value;
  let out = '';
  let used = 0;
  for (const char of plain) {
    const size = stringWidth(char);
    if (used + size > width - 1) break;
    out += char;
    used += size;
  }
  return `${out}…`;
}

export function formatAge(timestamp: number): string {
  const delta = Math.max(0, Date.now() - timestamp);
  if (delta < 60_000) return 'just now';
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.round(delta / 86_400_000)}d ago`;
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Strip terminal control characters from untrusted text before printing it. */
export function safeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function oneLine(value: string, max = 120): string {
  const clean = safeText(value).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1))}…` : clean;
}

export function isChatModel(id: string, name: string, model: CatalogProvider['models'][string]): boolean {
  if (model.modalities?.output && !model.modalities.output.includes('text')) return false;
  return !/(embed|embedding|tts|whisper|audio|speech|rerank|moderation|upscal|dall-e|stable-diffusion|flux|sora|veo|imagen|nano-banana|computer-use|realtime)/i.test(
    `${id} ${name}`
  );
}

export function credentialUsable(status: CredentialStatus, config: SurfConfig): boolean {
  if (!status.configured) return false;
  const provider = status.provider;
  if (!providerHasEndpoint(provider, config)) return false;
  const endpoint =
    config.providers[provider.id]?.baseURL ??
    config.customProviders[provider.id]?.baseURL ??
    provider.api ??
    '';
  const localEndpoint =
    provider.local || /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(endpoint);
  const explicitEndpoint = Boolean(
    config.providers[provider.id]?.baseURL || config.customProviders[provider.id]?.baseURL
  );
  if (localEndpoint && !provider.discovered && !explicitEndpoint) return false;
  return true;
}

export function providerStatusLabel(status: CredentialStatus | undefined, provider: CatalogProvider, config: SurfConfig): string {
  if (!credentialUsable(status ?? { provider, configured: false }, config)) {
    if (provider.local) return muted('offline');
    return muted('not connected');
  }
  switch (status?.source) {
    case 'env':
      return success(`env · ${status.envName ?? 'set'}`);
    case 'auth':
      return success('saved key');
    case 'config':
      return success('config key');
    case 'keyless':
      return provider.local ? success('local') : success('keyless');
    default:
      return success('connected');
  }
}

export interface PrepareOptions {
  config: SurfConfig;
  catalog: Catalog;
  provider?: string;
  model?: string;
  persist?: boolean;
}

export interface PreparedStartup {
  config: SurfConfig;
  note?: string;
  autoSelected: boolean;
}

export async function prepareStartup(options: PrepareOptions): Promise<PreparedStartup> {
  const requestedProvider = options.provider?.trim();
  let provider = requestedProvider || options.config.provider;
  let model = options.model?.trim();
  let autoSelected = false;

  if (!model && (!requestedProvider || requestedProvider === options.config.provider)) {
    model = options.config.model;
  }

  if (model?.includes('/')) {
    const slash = model.indexOf('/');
    const prefix = model.slice(0, slash);
    const rest = model.slice(slash + 1);
    if (requestedProvider) {
      // An explicit --provider wins. Strip only a redundant matching prefix;
      // otherwise the slash belongs to the model id (for example OpenRouter).
      if (prefix === requestedProvider && rest) model = rest;
    } else if (provider && findModel(options.catalog, provider, model)) {
      // Keep provider-local model ids that contain slashes.
    } else if (rest && providerById(options.catalog, prefix)) {
      // `--model provider/model` also selects the provider when it is unambiguous.
      provider = prefix;
      model = rest;
    }
  }

  if (!provider) {
    const statuses = await credentialStatus(options.catalog.providers, options.config);
    const ids = new Set(
      statuses.filter((status) => credentialUsable(status, options.config)).map((status) => status.provider.id)
    );
    const best = bestProviderWithCredential(options.catalog, ids);
    if (best) {
      provider = best.id;
      model = recommendedModel(best)?.id;
      autoSelected = true;
    }
  }

  if (provider) {
    const catalogProvider = providerById(options.catalog, provider);
    if (!catalogProvider && !options.config.customProviders[provider]) {
      throw new SurfError(`Unknown provider "${provider}"`, {
        hint: 'Run `surf providers` to see available providers.'
      });
    }
    if (!model && catalogProvider) {
      const suggestion = recommendedModel(catalogProvider);
      const fallback = Object.values(catalogProvider.models)
        .filter((entry) => isChatModel(entry.id, entry.name, entry))
        .sort((a, b) => scoreModel(b) - scoreModel(a))[0];
      model = suggestion?.id ?? fallback?.id;
    }
  }

  const nextConfig: SurfConfig = {
    ...options.config,
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {})
  };

  let finalConfig = nextConfig;
  if ((options.persist || autoSelected) && provider) {
    finalConfig = await updateConfig({ provider, ...(model ? { model } : {}) });
  }

  return {
    config: finalConfig,
    autoSelected,
    note: autoSelected && provider ? `Auto-selected ${provider}/${model ?? 'recommended model'}.` : undefined
  };
}

export async function readSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new SurfError('No TTY available for a hidden prompt', {
      hint: 'Pass --key, or run `surf auth <provider>` in an interactive terminal.'
    });
  }
  process.stderr.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return await new Promise<string>((resolve, reject) => {
    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
    };
    const onData = (data: string) => {
      const clean = data.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
      for (const char of clean) {
        if (char === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new SurfError('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value.trim());
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          value += char;
          process.stderr.write('•');
        }
      }
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === 'a' || answer === 'always';
  } finally {
    rl.close();
  }
}

export async function assertWritable(path: string): Promise<boolean> {
  try {
    await access(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function priceLabel(model: CatalogProvider['models'][string]): string {
  const price = formatPrice(model);
  return price === 'free' ? muted('free') : price;
}

export function contextLabel(model: CatalogProvider['models'][string]): string {
  const context = model.limit?.context;
  return context ? `${formatTokens(context)}` : '—';
}
