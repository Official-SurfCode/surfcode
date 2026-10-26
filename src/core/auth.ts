import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ensurePaths, getPaths, writeFileAtomic } from './paths.js';
import type { AuthStore, CatalogProvider, SurfConfig } from './types.js';

const authSchema = z.object({
  version: z.literal(1).default(1),
  keys: z.record(z.string(), z.string()).default({})
});

const LOCAL_PROVIDERS = new Set(['ollama', 'llamacpp', 'vllm', 'lmstudio']);

let cached: AuthStore | undefined;

export async function loadAuth(force = false): Promise<AuthStore> {
  const paths = getPaths();
  let raw: string;
  try {
    raw = await readFile(paths.authFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      cached = { version: 1, keys: {} };
      return cached;
    }
    throw error;
  }
  if (cached && !force) return cached;
  try {
    const parsed = authSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error('invalid shape');
    cached = parsed.data;
    return cached;
  } catch {
    throw new Error(`Could not parse auth file at ${paths.authFile}.`);
  }
}

export async function saveProviderKey(providerId: string, key: string): Promise<void> {
  await ensurePaths();
  const auth = await loadAuth(true);
  auth.keys[providerId] = key.trim();
  await writeFileAtomic(getPaths().authFile, `${JSON.stringify(auth, null, 2)}\n`);
  cached = auth;
}

export async function removeProviderKey(providerId: string): Promise<boolean> {
  const paths = getPaths();
  const auth = await loadAuth(true);
  if (!(providerId in auth.keys)) return false;
  delete auth.keys[providerId];
  await writeFileAtomic(paths.authFile, `${JSON.stringify(auth, null, 2)}\n`);
  cached = auth;
  return true;
}

export async function getStoredKey(providerId: string): Promise<string | undefined> {
  const auth = await loadAuth();
  return auth.keys[providerId]?.trim() || undefined;
}

export function envKeyFor(provider: CatalogProvider): string | undefined {
  for (const name of provider.env) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function envNameFor(provider: CatalogProvider): string | undefined {
  for (const name of provider.env) {
    if (process.env[name]?.trim()) return name;
  }
  return provider.env[0];
}

export function isKeylessProvider(provider: CatalogProvider): boolean {
  if (LOCAL_PROVIDERS.has(provider.id)) return true;
  if (provider.local) return true;
  // OpenAI-compatible localhost servers often do not require a key.
  return typeof provider.api === 'string' && /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(provider.api);
}

export interface CredentialStatus {
  provider: CatalogProvider;
  configured: boolean;
  source?: 'env' | 'auth' | 'config' | 'keyless';
  envName?: string;
  masked?: string;
}

export async function credentialStatus(
  providers: CatalogProvider[],
  config: SurfConfig
): Promise<CredentialStatus[]> {
  const auth = await loadAuth();
  return providers.map((provider) => {
    const settings = config.providers[provider.id] ?? config.customProviders[provider.id] ?? {};
    const envName = envNameFor(provider);
    if (settings?.apiKey?.trim()) {
      return { provider, configured: true, source: 'config' as const, envName, masked: mask(settings.apiKey) };
    }
    if (auth.keys[provider.id]?.trim()) {
      return { provider, configured: true, source: 'auth' as const, envName, masked: mask(auth.keys[provider.id]!) };
    }
    const envValue = envKeyFor(provider);
    if (envValue) {
      return { provider, configured: true, source: 'env' as const, envName, masked: mask(envValue) };
    }
    if (isKeylessProvider(provider) || settings?.keyless) {
      return { provider, configured: true, source: 'keyless' as const, envName };
    }
    return { provider, configured: false, envName };
  });
}

export function mask(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}
