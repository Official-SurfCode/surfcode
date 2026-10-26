import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { CatalogModel, CatalogProvider, ResolvedModel, SurfConfig } from './types.js';
import { getPaths, writeFileAtomic } from './paths.js';

const BUNDLED_CATALOG = fileURLToPath(new URL('../data/models.json', import.meta.url));
const CATALOG_TTL = 24 * 60 * 60 * 1000;

export interface Catalog {
  providers: CatalogProvider[];
  source: 'cache' | 'bundled';
  updatedAt?: number;
}

interface RawCatalog {
  [providerId: string]: CatalogProvider;
}

const LOCAL_PROVIDERS: CatalogProvider[] = [
  {
    id: 'ollama',
    name: 'Ollama (local)',
    env: [],
    api: 'http://127.0.0.1:11434/v1',
    models: {},
    local: true
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (local)',
    env: [],
    api: 'http://127.0.0.1:8080/v1',
    models: {},
    local: true
  },
  {
    id: 'vllm',
    name: 'vLLM (local)',
    env: [],
    api: 'http://127.0.0.1:8000/v1',
    models: {},
    local: true
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (local)',
    env: [],
    api: 'http://127.0.0.1:1234/v1',
    models: {},
    local: true
  }
];

let memoryCatalog: RawCatalog | undefined;

export async function loadCatalog(config?: SurfConfig): Promise<Catalog> {
  let source: Catalog['source'] = 'bundled';
  let updatedAt: number | undefined;
  let raw: RawCatalog | undefined;

  const cachePath = getPaths().modelsCache;
  try {
    const info = await stat(cachePath);
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as RawCatalog;
    if (isCatalog(cached)) {
      raw = cached;
      source = 'cache';
      updatedAt = info.mtimeMs;
    }
  } catch {
    // Cache is optional.
  }

  if (!raw) {
    raw = JSON.parse(await readFile(BUNDLED_CATALOG, 'utf8')) as RawCatalog;
  }
  memoryCatalog = raw;

  const providers = new Map<string, CatalogProvider>();
  for (const [id, provider] of Object.entries(raw)) {
    providers.set(id, { ...provider, id: provider.id ?? id, env: provider.env ?? [], models: provider.models ?? {} });
  }

  for (const local of LOCAL_PROVIDERS) {
    const existing = providers.get(local.id);
    if (existing) {
      existing.local = true;
      if (!existing.api) existing.api = local.api;
      existing.env = existing.env ?? [];
    } else {
      providers.set(local.id, { ...local, models: { ...local.models } });
    }
  }

  if (config) {
    for (const [id, custom] of Object.entries(config.customProviders)) {
      const models: Record<string, CatalogModel> = {};
      for (const model of custom.models ?? []) {
        models[model.id] = {
          id: model.id,
          name: model.name ?? model.id,
          tool_call: model.tool_call ?? true,
          reasoning: model.reasoning,
          limit: { context: model.context, output: model.output }
        };
      }
      providers.set(id, {
        id,
        name: custom.name,
        env: custom.env ?? [],
        api: custom.baseURL,
        doc: custom.doc,
        models,
        custom: true
      });
    }
  }

  return { providers: [...providers.values()].sort((a, b) => a.name.localeCompare(b.name)), source, updatedAt };
}

export async function refreshCatalog(
  url = process.env.SURFCODE_MODELS_URL || 'https://models.dev/api.json'
): Promise<Catalog> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'surfcode/0.1' },
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  const source = (await response.json()) as Record<string, any>;
  const compact: RawCatalog = {};
  for (const [id, provider] of Object.entries(source)) {
    if (!provider || typeof provider !== 'object') continue;
    const models: Record<string, CatalogModel> = {};
    for (const [modelKey, model] of Object.entries(provider.models ?? {}) as Array<[string, any]>) {
      if (!model || typeof model !== 'object') continue;
      models[modelKey] = {
        id: model.id ?? modelKey,
        name: model.name ?? model.id ?? modelKey,
        tool_call: model.tool_call ? true : undefined,
        reasoning: model.reasoning ? true : undefined,
        attachment: model.attachment ? true : undefined,
        release_date: model.release_date,
        limit: model.limit,
        cost: model.cost,
        modalities: model.modalities
      };
    }
    compact[id] = {
      id: provider.id ?? id,
      name: provider.name ?? id,
      env: provider.env ?? [],
      npm: provider.npm,
      api: provider.api,
      doc: provider.doc,
      models
    };
  }
  await writeFileAtomic(getPaths().modelsCache, JSON.stringify(compact), 0o600);
  memoryCatalog = compact;
  return loadCatalog();
}

export function catalogAge(updatedAt?: number): number | undefined {
  if (!updatedAt) return undefined;
  return Date.now() - updatedAt;
}

export function catalogIsStale(updatedAt?: number): boolean {
  if (!updatedAt) return true;
  return Date.now() - updatedAt > CATALOG_TTL;
}

export function providerById(catalog: Catalog, id: string): CatalogProvider | undefined {
  return catalog.providers.find((provider) => provider.id === id);
}

export function findModel(catalog: Catalog, providerId: string, modelId: string): CatalogModel | undefined {
  const provider = providerById(catalog, providerId);
  if (!provider) return undefined;
  return provider.models[modelId] ?? Object.values(provider.models).find((model) => model.id === modelId);
}

export function allModels(catalog: Catalog): Array<{ provider: CatalogProvider; model: CatalogModel }> {
  const result: Array<{ provider: CatalogProvider; model: CatalogModel }> = [];
  for (const provider of catalog.providers) {
    for (const model of Object.values(provider.models)) result.push({ provider, model });
  }
  return result;
}

const BAD_MODEL = /(embed|embedding|tts|whisper|audio|speech|image|video|vision-only|rerank|moderation|upscal|dall-e|stable-diffusion|flux|sora|veo|imagen|nano-banana|computer-use)/i;
const GOOD_MODEL = /(coder|codex|code|sonnet|opus|gpt-5|gpt-4\.1|gemini-3|deepseek-v4|kimi|qwen3|glm|grok-4|mistral-large|command-a)/i;

export function scoreModel(model: CatalogModel): number {
  if (BAD_MODEL.test(`${model.id} ${model.name}`)) return -1000;
  if (model.modalities?.output && !model.modalities.output.includes('text')) return -1000;
  let score = 0;
  if (model.tool_call) score += 50;
  if (model.reasoning) score += 8;
  if (GOOD_MODEL.test(`${model.id} ${model.name}`)) score += 30;
  if (/latest|preview/i.test(model.name)) score += 4;
  const context = model.limit?.context ?? 0;
  score += Math.min(20, Math.log10(Math.max(context, 1)) * 4);
  if (/free/i.test(model.id)) score += 2;
  if (model.release_date) {
    const year = Number(model.release_date.slice(0, 4));
    if (Number.isFinite(year)) score += Math.max(0, Math.min(8, (year - 2023) * 2));
  }
  if (!model.tool_call) score -= 10;
  return score;
}

export function recommendedModel(provider: CatalogProvider): CatalogModel | undefined {
  return Object.values(provider.models)
    .filter((model) => scoreModel(model) > 0)
    .sort((a, b) => scoreModel(b) - scoreModel(a))[0];
}

export function resolveResolvedModel(
  catalog: Catalog,
  providerId: string,
  modelId: string
): Omit<ResolvedModel, 'provider'> & { providerId: string } {
  const model = findModel(catalog, providerId, modelId);
  return {
    id: modelId,
    name: model?.name ?? modelId,
    providerId,
    meta: model,
    contextWindow: model?.limit?.context ?? 128_000,
    maxOutput: model?.limit?.output ?? 16_384
  };
}

export function parseModelReference(reference: string, defaultProvider?: string): { provider?: string; model: string } {
  const trimmed = reference.trim();
  if (!trimmed) return { provider: defaultProvider, model: '' };
  if (trimmed.includes('/') && defaultProvider) {
    const [first] = trimmed.split('/');
    // Provider ids can contain dots but not slashes. A slash usually belongs to the model id
    // (e.g. openrouter's anthropic/claude), so only split when asked explicitly via provider/model.
    if (first && /^[a-z0-9][a-z0-9._-]*$/i.test(first) && trimmed.includes('/')) {
      return { provider: defaultProvider, model: trimmed };
    }
  }
  return { provider: defaultProvider, model: trimmed };
}

export function parseExplicitModel(reference: string): { provider?: string; model: string } {
  const trimmed = reference.trim();
  const slash = trimmed.indexOf('/');
  if (slash > 0) {
    return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
  }
  return { model: trimmed };
}

/**
 * Discover models exposed by local OpenAI-compatible servers. Best-effort and
 * intentionally short-timeout so startup stays snappy.
 */
export async function discoverLocalModels(catalog: Catalog): Promise<Catalog> {
  const candidates = catalog.providers.filter((provider) => provider.local);
  await Promise.all(
    candidates.map(async (provider) => {
      try {
        if (provider.id === 'ollama') {
          const response = await fetch('http://127.0.0.1:11434/api/tags', {
            signal: AbortSignal.timeout(650)
          });
          if (!response.ok) return;
          provider.discovered = true;
          const data = (await response.json()) as { models?: Array<{ name?: string; model?: string; details?: any }> };
          for (const entry of data.models ?? []) {
            const id = entry.model ?? entry.name;
            if (!id) continue;
            provider.models[id] = {
              id,
              name: id,
              tool_call: true,
              limit: { context: 32_768, output: 8_192 }
            };
          }
          return;
        }
        const response = await fetch(`${provider.api!.replace(/\/v1\/?$/, '')}/v1/models`, {
          signal: AbortSignal.timeout(650)
        });
        if (!response.ok) return;
        provider.discovered = true;
        const data = (await response.json()) as { data?: Array<{ id?: string }> };

        for (const entry of data.data ?? []) {
          if (!entry.id) continue;
          provider.models[entry.id] = {
            id: entry.id,
            name: entry.id,
            tool_call: true,
            limit: { context: 32_768, output: 8_192 }
          };
        }
      } catch {
        // Local server not running; leave the provider in the catalog.
      }
    })
  );
  return catalog;
}

function isCatalog(value: unknown): value is RawCatalog {
  if (!value || typeof value !== 'object') return false;
  const providers = Object.values(value as Record<string, unknown>);
  if (providers.length === 0) return false;
  return providers.every((provider) => {
    if (!provider || typeof provider !== 'object') return false;
    const candidate = provider as CatalogProvider;
    return typeof candidate.name === 'string' && candidate.models !== null && typeof candidate.models === 'object';
  });
}

export { LOCAL_PROVIDERS };
