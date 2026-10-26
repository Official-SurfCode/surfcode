import { readFile } from 'node:fs/promises';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import { EFFORT_SETTINGS } from './effort.js';
import { SurfError } from './errors.js';
import { ensurePaths, getPaths, writeFileAtomic } from './paths.js';
import type { SurfConfig } from './types.js';

const permissionMode = z.enum(['allow', 'ask', 'deny']);

const providerSettingsSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  dialect: z.enum(['openai', 'anthropic', 'google', 'azure', 'google-vertex']).optional(),
  apiVersion: z.string().optional(),
  deployment: z.string().optional(),
  project: z.string().optional(),
  location: z.string().optional(),
  extraBody: z.record(z.string(), z.unknown()).optional(),
  timeout: z.number().positive().optional(),
  retries: z.number().int().min(0).max(10).optional(),
  retryDelay: z.number().int().min(0).max(60_000).optional(),
  keyless: z.boolean().optional()
});

const syncSchema = z.object({
  url: z.string().url().optional(),
  token: z.string().optional(),
  enabled: z.boolean().default(false),
  auto: z.boolean().default(false),
  cursor: z.number().int().min(0).default(0),
  lastSyncAt: z.number().optional(),
  deviceId: z.string().optional()
});

const customProviderSchema = providerSettingsSchema.extend({
  name: z.string().min(1),
  env: z.array(z.string()).optional(),
  doc: z.string().optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        context: z.number().positive().optional(),
        output: z.number().positive().optional(),
        tool_call: z.boolean().optional(),
        reasoning: z.boolean().optional()
      })
    )
    .optional()
});

const agentWorkerSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1)
});

const agentsSchema = z.object({
  enabled: z.boolean().default(false),
  workers: z.array(agentWorkerSchema).default([])
});

export const configSchema = z.object({
  version: z.literal(1).default(1),
  provider: z.string().optional(),
  model: z.string().optional(),
  theme: z.string().default('aurora'),
  mode: z.enum(['build', 'plan']).default('build'),
  permissions: z
    .object({
      read: permissionMode.default('allow'),
      write: permissionMode.default('ask'),
      shell: permissionMode.default('ask'),
      fetch: permissionMode.default('allow')
    })
    .default({ read: 'allow', write: 'ask', shell: 'ask', fetch: 'allow' }),
  maxSteps: z.number().int().min(1).max(200).default(40),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  effort: z.enum(EFFORT_SETTINGS).default('auto'),
  showReasoning: z.boolean().default(false),
  verboseTools: z.boolean().default(false),
  streaming: z.boolean().default(false),
  explorerWidth: z.number().int().min(24).max(80).default(34),
  fullAccess: z.boolean().default(false),
  agents: agentsSchema.default({ enabled: false, workers: [] }),
  allowOutsideWorkspace: z.boolean().default(false),
  providers: z.record(z.string(), providerSettingsSchema).default({}),
  customProviders: z.record(z.string(), customProviderSchema).default({}),
  sync: syncSchema.default({ enabled: false, auto: false, cursor: 0 })
});

export function defaultConfig(): SurfConfig {
  return configSchema.parse({});
}

export async function loadConfig(): Promise<SurfConfig> {
  const paths = getPaths();
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return applyEnvOverrides(defaultConfig());
    }
    throw error;
  }

  const errors: ParseError[] = [];
  const parsed = parse(raw, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0) {
    throw new SurfError(`Could not parse ${paths.configFile}`, {
      hint: 'Fix the JSONC syntax, or remove the file to start with defaults.'
    });
  }

  const result = configSchema.safeParse(parsed ?? {});
  if (!result.success) {
    throw new SurfError(`Invalid config at ${paths.configFile}`, {
      hint: result.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`).join('\n')
    });
  }
  return applyEnvOverrides(result.data);
}

function applyEnvOverrides(config: SurfConfig): SurfConfig {
  if (process.env.SURFCODE_PROVIDER) config.provider = process.env.SURFCODE_PROVIDER;
  if (process.env.SURFCODE_MODEL) config.model = process.env.SURFCODE_MODEL;
  if (process.env.SURFCODE_THEME) config.theme = process.env.SURFCODE_THEME;
  const syncUrl = process.env.SURFCODE_SYNC_URL?.trim();
  const syncToken = process.env.SURFCODE_SYNC_TOKEN?.trim();
  if (syncUrl) config.sync.url = syncUrl;
  if (syncToken) config.sync.token = syncToken;
  // Supplying both through the environment is enough to opt in, so ephemeral
  // CI/container runs never need to write the bearer token to disk.
  if (syncUrl && syncToken) config.sync.enabled = true;
  return config;
}

export async function saveConfig(config: SurfConfig): Promise<void> {
  await ensurePaths();
  const paths = getPaths();
  const result = configSchema.safeParse(config);
  if (!result.success) {
    throw new SurfError(`Refusing to write an invalid config: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  await writeFileAtomic(paths.configFile, `${JSON.stringify(result.data, null, 2)}\n`);
}

export async function updateConfig(values: Partial<SurfConfig>): Promise<SurfConfig> {
  await ensurePaths();
  const paths = getPaths();
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') raw = '{}\n';
    else throw error;
  }

  let updated = raw;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    updated = applyEdits(
      updated,
      modify(updated, [key], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' }
      })
    );
  }
  if (!updated.endsWith('\n')) updated += '\n';
  const parsed = configSchema.safeParse(parse(updated) ?? {});
  if (!parsed.success) {
    throw new SurfError(`Refusing to write invalid config: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  await writeFileAtomic(paths.configFile, updated);
  return loadConfig();
}

/** Write a single value at a dot-separated path while preserving JSONC comments. */
export async function updateConfigPath(path: Array<string | number>, value: unknown): Promise<SurfConfig> {
  await ensurePaths();
  const paths = getPaths();
  let raw: string;
  try {
    raw = await readFile(paths.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') raw = '{}\n';
    else throw error;
  }

  let updated = applyEdits(
    raw,
    modify(raw, path, value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' }
    })
  );
  if (!updated.endsWith('\n')) updated += '\n';
  const parsed = configSchema.safeParse(parse(updated) ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SurfError(
      `Refusing to write invalid config: ${issue ? `${issue.path.join('.') || 'config'}: ${issue.message}` : 'unknown error'}`
    );
  }
  await writeFileAtomic(paths.configFile, updated);
  return loadConfig();
}

export function readConfigValue(config: SurfConfig, path: string[]): unknown {
  let current: unknown = config;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return undefined;
    if (Array.isArray(current) && /^\d+$/.test(segment)) current = current[Number(segment)];
    else current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
