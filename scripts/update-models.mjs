import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.SURFCODE_MODELS_URL || 'https://models.dev/api.json';

console.log(`fetching ${url}…`);
const response = await fetch(url, { signal: AbortSignal.timeout(45_000) });
if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);

const source = await response.json();
const catalog = {};

for (const [key, provider] of Object.entries(source)) {
  if (!provider || typeof provider !== 'object') continue;
  const models = {};
  for (const [modelKey, model] of Object.entries(provider.models || {})) {
    if (!model || typeof model !== 'object') continue;
    models[modelKey] = {
      id: model.id ?? modelKey,
      name: model.name ?? model.id ?? modelKey,
      ...(model.tool_call ? { tool_call: true } : {}),
      ...(model.reasoning ? { reasoning: true } : {}),
      ...(model.attachment ? { attachment: true } : {}),
      ...(model.limit ? { limit: model.limit } : {}),
      ...(model.cost ? { cost: model.cost } : {}),
      ...(model.release_date ? { release_date: model.release_date } : {}),
      ...(model.modalities ? { modalities: model.modalities } : {})
    };
  }
  catalog[key] = {
    id: provider.id ?? key,
    name: provider.name ?? key,
    env: provider.env ?? [],
    ...(provider.npm ? { npm: provider.npm } : {}),
    ...(provider.api ? { api: provider.api } : {}),
    ...(provider.doc ? { doc: provider.doc } : {}),
    models
  };
}

const target = resolve(root, 'src', 'data', 'models.json');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(catalog));
const modelCount = Object.values(catalog).reduce((sum, p) => sum + Object.keys(p.models).length, 0);
console.log(`wrote ${Object.keys(catalog).length} providers / ${modelCount} models (${(JSON.stringify(catalog).length / 1e6).toFixed(2)} MB)`);
