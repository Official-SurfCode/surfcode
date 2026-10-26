import envPaths from 'env-paths';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface SurfPaths {
  configDir: string;
  dataDir: string;
  cacheDir: string;
  configFile: string;
  authFile: string;
  sessionsDir: string;
  modelsCache: string;
}

export function getPaths(): SurfPaths {
  const override = process.env.SURFCODE_HOME?.trim();
  const base = override
    ? { config: override, data: override, cache: override }
    : envPaths('surfcode', { suffix: '' });

  return {
    configDir: base.config,
    dataDir: base.data,
    cacheDir: base.cache,
    configFile: join(base.config, 'config.json'),
    authFile: join(base.config, 'auth.json'),
    sessionsDir: join(base.data, 'sessions'),
    modelsCache: join(base.cache, 'models.json')
  };
}

export async function ensurePaths(): Promise<SurfPaths> {
  const paths = getPaths();
  await Promise.all([
    mkdir(paths.configDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.dataDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.cacheDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 })
  ]);
  return paths;
}

export async function writeFileAtomic(path: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode });
  await rename(temporary, path);
  try {
    await chmod(path, mode);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
