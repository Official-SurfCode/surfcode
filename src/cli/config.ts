import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import {
  defaultConfig,
  loadConfig,
  readConfigValue,
  saveConfig,
  updateConfigPath
} from '../core/config.js';
import { SurfError } from '../core/errors.js';
import { ensurePaths, getPaths } from '../core/paths.js';
import type { SurfConfig } from '../core/types.js';
import { accent, danger, muted, success, title, warning, write } from './util.js';

const TOP_LEVEL_KEYS = new Set([
  'version',
  'provider',
  'model',
  'theme',
  'mode',
  'permissions',
  'maxSteps',
  'maxTokens',
  'temperature',
  'effort',
  'showReasoning',
  'verboseTools',
  'streaming',
  'explorerWidth',
  'fullAccess',
  'agents',
  'allowOutsideWorkspace',
  'providers',
  'customProviders',
  'sync'
]);

const SYNC_KEYS = new Set(['url', 'token', 'enabled', 'auto', 'cursor', 'lastSyncAt', 'deviceId']);

const PROVIDER_KEYS = new Set([
  'apiKey',
  'baseURL',
  'headers',
  'dialect',
  'apiVersion',
  'deployment',
  'project',
  'location',
  'extraBody',
  'timeout',
  'retries',
  'retryDelay',
  'keyless',
  'name',
  'env',
  'doc',
  'models'
]);

const PERMISSION_KEYS = new Set(['read', 'write', 'shell', 'fetch']);
const AGENTS_KEYS = new Set(['enabled', 'workers']);

export async function configShowCommand(): Promise<number> {
  const paths = getPaths();
  const config = await loadConfig();
  let exists = false;
  try {
    await stat(paths.configFile);
    exists = true;
  } catch {
    // Defaults are in use.
  }

  write(`${title('Config')} ${muted(`· ${paths.configFile}`)}`);
  if (!exists) write(muted('  file does not exist yet · showing defaults'));
  write();
  write(JSON.stringify(redact(config), null, 2));
  write();
  write(muted('Secrets are redacted. Edit the file to change API keys.'));
  return 0;
}

export async function configPathCommand(): Promise<number> {
  await ensurePaths();
  write(getPaths().configFile);
  return 0;
}

export async function configGetCommand(key: string, options: { json?: boolean }): Promise<number> {
  const raw = await readFile(getPaths().configFile, 'utf8').catch(() => undefined);
  if (!raw) {
    write(options.json ? 'null' : muted('(not set)'));
    return 0;
  }
  const config = await loadConfig();
  const value = redactValue(readConfigValue(config, key.split('.')), key.split('.').at(-1));
  if (value === undefined) {
    write(options.json ? 'null' : muted('(not set)'));
    return 0;
  }
  if (options.json) {
    write(JSON.stringify(value, null, 2));
    return 0;
  }
  if (typeof value === 'string') write(value);
  else if (typeof value === 'number' || typeof value === 'boolean') write(String(value));
  else write(JSON.stringify(value, null, 2));
  return 0;
}

export async function configSetCommand(key: string, rawValue: string): Promise<number> {
  const path = key.split('.').filter(Boolean);
  if (path.length === 0) throw new SurfError('A config key is required.');
  if (!TOP_LEVEL_KEYS.has(path[0]!)) {
    throw new SurfError(`Unknown config key "${path[0]}"`, {
      hint: `Top-level keys: ${[...TOP_LEVEL_KEYS].join(', ')}.`
    });
  }
  if (path[0] === 'permissions' && path[1] && !PERMISSION_KEYS.has(path[1])) {
    throw new SurfError(`Unknown permission "${path[1]}"`, {
      hint: `Permissions: ${[...PERMISSION_KEYS].join(', ')}.`
    });
  }
  if (path[0] === 'sync' && path[1] && !SYNC_KEYS.has(path[1])) {
    throw new SurfError(`Unknown sync setting "${path[1]}"`, {
      hint: `Sync settings: ${[...SYNC_KEYS].join(', ')}.`
    });
  }
  if (path[0] === 'agents' && path[1] && !AGENTS_KEYS.has(path[1])) {
    throw new SurfError(`Unknown agent setting "${path[1]}"`, {
      hint: `Agent settings: ${[...AGENTS_KEYS].join(', ')}.`
    });
  }
  if (
    (path[0] === 'providers' || path[0] === 'customProviders') &&
    path.length === 3 &&
    !PROVIDER_KEYS.has(path[2]!)
  ) {
    throw new SurfError(`Unknown provider setting "${path[2]}"`, {
      hint: `Provider settings: ${[...PROVIDER_KEYS].join(', ')}.`
    });
  }

  const value = parseValue(rawValue);
  const config = await updateConfigPath(path, value);
  const saved = readConfigValue(config, path);
  const shown = isSensitivePath(path) ? '<redacted>' : formatValue(saved);
  write(`${success('✓')} ${accent(path.join('.'))} ${muted('=')} ${shown}`);
  return 0;
}

export async function configValidateCommand(): Promise<number> {
  try {
    const config = await loadConfig();
    write(`${success('✓')} Valid config ${muted(`· ${getPaths().configFile}`)}`);
    write(muted(`  ${Object.keys(config.providers).length} provider settings · ${Object.keys(config.customProviders).length} custom providers`));
    return 0;
  } catch (error) {
    write(`${danger('✗')} ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof SurfError && error.hint) write(muted(`  ${error.hint}`));
    return 1;
  }
}

export async function configEditCommand(): Promise<number> {
  const paths = await ensurePaths();
  try {
    await stat(paths.configFile);
  } catch {
    await saveConfig(defaultConfig());
    write(muted(`Created ${paths.configFile} with defaults.`));
  }

  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
  const parts = editor.trim().split(/\s+/);
  const command = parts[0] ?? 'vi';
  const args = [...parts.slice(1), paths.configFile];

  const code = await new Promise<number | null>((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (error) =>
      reject(
        new SurfError(`Could not open ${editor}`, {
          hint: error.message
        })
      )
    );
    child.on('close', (exitCode) => resolvePromise(exitCode));
  });

  if (code !== 0) throw new SurfError(`The editor exited with code ${code}.`);

  try {
    await loadConfig();
  } catch (error) {
    write(warning(`The config was saved but is not valid yet: ${error instanceof Error ? error.message : String(error)}`));
    return 1;
  }
  write(`${success('✓')} Config updated.`);
  return 0;
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value === '') return '';
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return raw;
  }
}

function isSensitivePath(path: string[]): boolean {
  const last = path.at(-1) ?? '';
  return /^(apiKey|api_key|authorization|token|secret|password|x-api-key)$/i.test(last) || path.includes('headers');
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined) return muted('(not set)');
  return JSON.stringify(value);
}

function redact(config: SurfConfig): unknown {
  return redactValue(config, undefined);
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && /^(apiKey|api_key|authorization|token|secret|password|x-api-key)$/i.test(key)) {
    return value ? '<redacted>' : value;
  }
  if (key === 'headers' && value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name]) => [name, '<redacted>'])
    );
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([name, entry]) => [
        name,
        redactValue(entry, name)
      ])
    );
  }
  return value;
}
