import { getStoredKey } from './auth.js';
import { findModel, recommendedModel, type Catalog } from './catalog.js';
import { SurfError } from './errors.js';
import type {
  CatalogModel,
  CatalogProvider,
  Dialect,
  ResolvedModel,
  ResolvedProvider,
  SurfConfig
} from './types.js';

const KNOWN_ENDPOINTS: Record<string, { baseURL: string; dialect?: Dialect }> = {
  openai: { baseURL: 'https://api.openai.com/v1' },
  anthropic: { baseURL: 'https://api.anthropic.com', dialect: 'anthropic' },
  google: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', dialect: 'google' },
  mistral: { baseURL: 'https://api.mistral.ai/v1' },
  xai: { baseURL: 'https://api.x.ai/v1' },
  groq: { baseURL: 'https://api.groq.com/openai/v1' },
  cerebras: { baseURL: 'https://api.cerebras.ai/v1' },
  togetherai: { baseURL: 'https://api.together.xyz/v1' },
  cohere: { baseURL: 'https://api.cohere.ai/compatibility/v1' },
  deepinfra: { baseURL: 'https://api.deepinfra.com/v1/openai' },
  perplexity: { baseURL: 'https://api.perplexity.ai' },
  perplexityAgent: { baseURL: 'https://api.perplexity.ai/v1' },
  vercel: { baseURL: 'https://ai-gateway.vercel.sh/v1' },
  venice: { baseURL: 'https://api.venice.ai/api/v1' },
  aihubmix: { baseURL: 'https://aihubmix.com/v1' },
  openrouter: { baseURL: 'https://openrouter.ai/api/v1' },
  'ollama-cloud': { baseURL: 'https://ollama.com/v1' },
  ollama: { baseURL: 'http://127.0.0.1:11434/v1' },
  lmstudio: { baseURL: 'http://127.0.0.1:1234/v1' },
  llamacpp: { baseURL: 'http://127.0.0.1:8080/v1' },
  vllm: { baseURL: 'http://127.0.0.1:8000/v1' }
};

const SPECIAL_ENV: Record<string, string[]> = {
  'google-vertex': ['GOOGLE_VERTEX_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN', 'GOOGLE_API_KEY'],
  'google-vertex-anthropic': ['GOOGLE_VERTEX_ACCESS_TOKEN', 'GOOGLE_ACCESS_TOKEN'],
  'amazon-bedrock': ['AWS_BEARER_TOKEN_BEDROCK'],
  azure: ['AZURE_API_KEY', 'AZURE_OPENAI_API_KEY'],
  'azure-cognitive-services': ['AZURE_COGNITIVE_SERVICES_API_KEY'],
  'github-copilot': ['GITHUB_TOKEN', 'GH_TOKEN']
};

const PROPRIETARY = new Set(['amazon-bedrock', 'google-vertex', 'google-vertex-anthropic', 'watsonx', 'sap-ai-core', 'gitlab', 'qvac']);

export function providerHasEndpoint(provider: CatalogProvider, config: SurfConfig): boolean {
  const settings = config.providers[provider.id] ?? config.customProviders[provider.id];
  if (settings?.baseURL) return true;
  if (provider.custom || provider.local || provider.api) return true;
  if (KNOWN_ENDPOINTS[provider.id]) return true;
  if (provider.id === 'azure' || provider.id === 'azure-cognitive-services') {
    return Boolean(process.env.AZURE_RESOURCE_NAME || process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME);
  }
  if (provider.id === 'google-vertex' || provider.id === 'google-vertex-anthropic') {
    return Boolean(settings?.project || process.env.GOOGLE_VERTEX_PROJECT);
  }
  if (provider.id === 'cloudflare-ai-gateway') {
    return Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_GATEWAY_ID);
  }
  return false;
}

export function knownEndpoint(provider: CatalogProvider): string | undefined {
  return KNOWN_ENDPOINTS[provider.id]?.baseURL;
}

export function inferDialect(provider: CatalogProvider, settings?: { dialect?: Dialect }): Dialect {
  if (settings?.dialect) return settings.dialect;
  if (provider.id === 'anthropic') return 'anthropic';
  if (provider.id === 'google') return 'google';
  if (provider.id === 'azure' || provider.id === 'azure-cognitive-services') return 'azure';
  if (provider.id === 'google-vertex' || provider.id === 'google-vertex-anthropic') return 'google-vertex';
  if (provider.npm === '@ai-sdk/anthropic' || provider.npm === '@ai-sdk/google-vertex/anthropic') return 'anthropic';
  if (provider.npm === '@ai-sdk/google') return 'google';
  if (provider.npm === '@ai-sdk/azure') return 'azure';
  if (provider.npm === '@ai-sdk/google-vertex') return 'google-vertex';
  return 'openai';
}

function interpolateEnv(value: string, provider: CatalogProvider): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => {
    const found = process.env[name];
    if (!found) {
      throw new SurfError(`Missing ${name} for ${provider.name}`, {
        hint: `Export ${name} before starting SurfCode.`
      });
    }
    return found;
  });
}

function withProtocol(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

async function resolveBaseUrl(
  provider: CatalogProvider,
  settings: SurfConfig['providers'][string],
  config: SurfConfig
): Promise<string | undefined> {
  if (settings.baseURL) return withProtocol(settings.baseURL);
  if (provider.api) return interpolateEnv(provider.api, provider);

  const known = KNOWN_ENDPOINTS[provider.id];
  if (known) return known.baseURL;

  if (provider.id === 'azure' || provider.id === 'azure-cognitive-services') {
    const resource = process.env.AZURE_RESOURCE_NAME || process.env.AZURE_COGNITIVE_SERVICES_RESOURCE_NAME;
    if (resource) {
      const host =
        provider.id === 'azure'
          ? `https://${resource}.openai.azure.com`
          : `https://${resource}.cognitiveservices.azure.com`;
      return host;
    }
  }

  if (provider.id === 'google-vertex' || provider.id === 'google-vertex-anthropic') {
    const project = settings.project || process.env.GOOGLE_VERTEX_PROJECT;
    const location = settings.location || process.env.GOOGLE_VERTEX_LOCATION || 'us-central1';
    if (!project) return undefined;
    const host =
      location === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${location}-aiplatform.googleapis.com`;
    return `${host}/v1/projects/${project}/locations/${location}/publishers/google/models`;
  }

  if (provider.id === 'cloudflare-ai-gateway') {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const gateway = process.env.CLOUDFLARE_GATEWAY_ID;
    if (account && gateway) {
      return `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/compat`;
    }
  }

  return undefined;
}

async function resolveApiKey(
  provider: CatalogProvider,
  settings: SurfConfig['providers'][string],
  dialect: Dialect
): Promise<{ key?: string; envName?: string }> {
  if (settings.apiKey?.trim()) return { key: settings.apiKey.trim() };
  const stored = await getStoredKey(provider.id);
  if (stored) return { key: stored };

  for (const name of SPECIAL_ENV[provider.id] ?? []) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, envName: name };
  }
  for (const name of provider.env) {
    const value = process.env[name]?.trim();
    if (value) return { key: value, envName: name };
  }
  return {};
}

export interface ResolveProviderOptions {
  catalog: Catalog;
  config: SurfConfig;
  providerId: string;
}

export async function resolveProvider({
  catalog,
  config,
  providerId
}: ResolveProviderOptions): Promise<ResolvedProvider> {
  const provider = catalog.providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new SurfError(`Unknown provider "${providerId}"`, {
      hint: 'Run `surf providers` to see every available provider.'
    });
  }

  const custom = config.customProviders[provider.id];
  const settings = {
    ...(custom ?? {}),
    ...(config.providers[provider.id] ?? {})
  } as SurfConfig['providers'][string];
  const dialect = inferDialect(provider, settings);
  const baseURL = await resolveBaseUrl(provider, settings, config);
  if (!baseURL) {
    throw new SurfError(`${provider.name} requires a custom endpoint`, {
      hint: PROPRIETARY.has(provider.id)
        ? `This provider uses a proprietary API. Point it at an OpenAI-compatible gateway with providers.${provider.id}.baseURL in ${'~/.config/surfcode/config.json'}.`
        : `Add providers.${provider.id}.baseURL to your SurfCode config.`
    });
  }

  const { key, envName } = await resolveApiKey(provider, settings, dialect);
  const keyless =
    settings.keyless ||
    provider.local ||
    /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseURL) ||
    dialect === 'google-vertex';
  if (!key && !keyless) {
    const envHint = [...(SPECIAL_ENV[provider.id] ?? []), ...provider.env].filter(Boolean).join(' or ');
    throw new SurfError(`No API key for ${provider.name}`, {
      hint: `Run \`surf auth ${provider.id}\`${envHint ? `, or set ${envHint}` : ''}.`
    });
  }

  const headers: Record<string, string> = { ...(settings.headers ?? {}) };
  const isAzure = dialect === 'azure';
  if (key) {
    if (dialect === 'anthropic') {
      headers['x-api-key'] = key;
      headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    } else if (dialect === 'google' || dialect === 'google-vertex') {
      if (dialect === 'google-vertex') headers.authorization = `Bearer ${key}`;
      else headers['x-goog-api-key'] = key;
    } else if (isAzure) {
      headers['api-key'] = key;
    } else {
      headers.authorization = `Bearer ${key}`;
    }
  }

  if (provider.id === 'openrouter') {
    headers['HTTP-Referer'] ||= 'https://surfcode.dev';
    headers['X-Title'] ||= 'SurfCode';
  }

  return {
    id: provider.id,
    name: provider.name,
    dialect,
    baseURL: baseURL.replace(/\/+$/, ''),
    apiKey: key,
    headers,
    settings,
    envName,
    keyless
  };
}

export interface ModelSelection {
  provider?: string;
  model?: string;
  modelRef?: string;
}

export function resolveModelReference(
  catalog: Catalog,
  config: SurfConfig,
  explicit?: { provider?: string; model?: string }
): ModelSelection {
  const providerId = explicit?.provider || config.provider;
  const modelId = explicit?.model || config.model;
  if (!modelId) return { provider: providerId };
  if (!explicit?.provider && modelId.includes('/')) {
    const slash = modelId.indexOf('/');
    const prefix = modelId.slice(0, slash);
    const rest = modelId.slice(slash + 1);
    const prefixProvider = catalog.providers.find((p) => p.id === prefix);
    const currentProvider = providerId ? catalog.providers.find((p) => p.id === providerId) : undefined;
    const fullExistsInCurrent = currentProvider && currentProvider.models[modelId];
    const restExistsInPrefix = prefixProvider && prefixProvider.models[rest];
    if (!fullExistsInCurrent && restExistsInPrefix) {
      return { provider: prefix, model: rest, modelRef: modelId };
    }
  }
  return { provider: providerId, model: modelId, modelRef: modelId };
}

export interface ResolvedSelection {
  provider: ResolvedProvider;
  model: ResolvedModel;
  catalogModel?: CatalogModel;
}

export async function resolveSelection(
  catalog: Catalog,
  config: SurfConfig,
  explicit?: { provider?: string; model?: string }
): Promise<ResolvedSelection> {
  const selection = resolveModelReference(catalog, config, explicit);
  if (!selection.provider) {
    throw new SurfError('No provider selected', {
      hint: 'Run `surf auth <provider>` or open SurfCode and use /connect.'
    });
  }
  if (!selection.model) {
    const provider = catalog.providers.find((entry) => entry.id === selection.provider);
    if (provider) {
      const suggestion = recommendedModel(provider);
      if (suggestion) selection.model = suggestion.id;
    }
  }
  if (!selection.model) {
    throw new SurfError(`No model selected for ${selection.provider}`, {
      hint: `Run \`surf models --provider ${selection.provider}\` and pass --model.`
    });
  }

  const provider = await resolveProvider({ catalog, config, providerId: selection.provider });
  const meta = findModel(catalog, selection.provider, selection.model);
  return {
    provider,
    catalogModel: meta,
    model: {
      id: selection.model,
      name: meta?.name ?? selection.model,
      provider,
      meta,
      contextWindow: meta?.limit?.context ?? 128_000,
      maxOutput: meta?.limit?.output ?? 16_384
    }
  };
}

export function bestProviderWithCredential(
  catalog: Catalog,
  credentialIds: Set<string>
): CatalogProvider | undefined {
  const priority = [
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
    'vercel'
  ];
  const ordered = [
    ...priority.map((id) => catalog.providers.find((provider) => provider.id === id)).filter(Boolean),
    ...catalog.providers
  ] as CatalogProvider[];
  for (const provider of ordered) {
    if (credentialIds.has(provider.id) && recommendedModel(provider)) return provider;
  }
  return undefined;
}

export function formatModel(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}
