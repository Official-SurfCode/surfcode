import { open, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isProbablyBinary, resolveWorkspacePath } from '../core/workspace.js';

/** Directories that are never useful in a project tree and can be enormous. */
const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.yarn',
  '.pnpm-store',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.idea',
  '.gradle'
]);

const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const PREVIEW_BYTES = 256 * 1024;
const PREVIEW_LINES = 400;
const MAX_ENTRIES = 20_000;

export const EXPLORER_MIN_WIDTH = 24;
export const EXPLORER_MIN_CHAT_WIDTH = 32;
export const EXPLORER_DOCK_GAP = 1;

/** Clamp a configured dock width so the chat always keeps usable room. */
export function clampExplorerWidth(value: number, terminalWidth: number): number {
  const rounded = Number.isFinite(value) ? Math.round(value) : 34;
  const max = Math.max(
    EXPLORER_MIN_WIDTH,
    Math.min(80, terminalWidth - EXPLORER_MIN_CHAT_WIDTH - EXPLORER_DOCK_GAP)
  );
  return Math.max(EXPLORER_MIN_WIDTH, Math.min(max, rounded));
}

/**
 * Width of the always-visible explorer dock, or 0 when the terminal is too
 * narrow to host both panes. The configured width is clamped on every frame so
 * shrinking the terminal never squeezes the chat into a sliver.
 */
export function explorerDockWidth(configured: number, terminalWidth: number): number {
  if (terminalWidth < EXPLORER_MIN_WIDTH + EXPLORER_MIN_CHAT_WIDTH + EXPLORER_DOCK_GAP) return 0;
  return clampExplorerWidth(configured, terminalWidth);
}

export interface ExplorerEntry {
  /** Workspace-relative POSIX path. */
  path: string;
  name: string;
  kind: 'file' | 'directory';
  depth: number;
}

export interface ExplorerPreview {
  path: string;
  lines: string[];
  bytes: number;
  truncated: boolean;
  binary: boolean;
}

export function isExplorerDirectory(entry: ExplorerEntry | undefined): boolean {
  return entry?.kind === 'directory';
}

/**
 * Build the visible tree. Only expanded directories are read, so opening the
 * explorer in a large repository costs one `readdir` instead of a full walk.
 */
export async function listExplorer(cwd: string, expanded: string[]): Promise<ExplorerEntry[]> {
  const expandedSet = new Set(expanded);
  const entries: ExplorerEntry[] = [];

  const walk = async (directory: string, depth: number): Promise<void> => {
    let dirents;
    try {
      dirents = await readdir(resolve(cwd, directory), { withFileTypes: true });
    } catch {
      // A single unreadable directory should not break the whole tree.
      return;
    }
    const sorted = dirents
      .filter((dirent) => {
        if (dirent.isDirectory()) return !SKIP_DIRS.has(dirent.name);
        return !SKIP_FILES.has(dirent.name);
      })
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });

    for (const dirent of sorted) {
      if (entries.length >= MAX_ENTRIES) return;
      const path = directory ? `${directory}/${dirent.name}` : dirent.name;
      const directoryEntry = dirent.isDirectory();
      if (!directoryEntry && !dirent.isFile() && !dirent.isSymbolicLink()) continue;
      entries.push({
        path,
        name: dirent.name,
        kind: directoryEntry ? 'directory' : 'file',
        depth
      });
      if (directoryEntry && expandedSet.has(path)) await walk(path, depth + 1);
    }
  };

  await walk('', 0);
  return entries;
}

/** Read a bounded, sanitized slice of a file for the preview pane. */
export async function readExplorerPreview(cwd: string, path: string): Promise<ExplorerPreview> {
  const resolved = resolveWorkspacePath(path, cwd, false);
  const handle = await open(resolved.absolute, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return { path, lines: [], bytes: 0, truncated: false, binary: true };
    }
    const length = Math.min(stats.size, PREVIEW_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    if (isProbablyBinary(buffer)) {
      return { path, lines: [], bytes: stats.size, truncated: stats.size > length, binary: true };
    }
    const text = buffer.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const all = text.split('\n');
    if (all.length > 1 && all[all.length - 1] === '') all.pop();
    const truncated = stats.size > length || all.length > PREVIEW_LINES;
    return {
      path,
      lines: all.slice(0, PREVIEW_LINES).map((line) => line.replace(/\t/g, '  ')),
      bytes: stats.size,
      truncated,
      binary: false
    };
  } finally {
    await handle.close();
  }
}

/** The parent directory of a workspace-relative path, or undefined at root. */
export function explorerParent(path: string): string | undefined {
  const index = path.lastIndexOf('/');
  return index === -1 ? undefined : path.slice(0, index);
}

/** Find an entry by path in a flattened tree. */
export function findExplorerEntry(entries: ExplorerEntry[], path: string): ExplorerEntry | undefined {
  return entries.find((entry) => entry.path === path);
}

export function explorerRelativeLabel(cwd: string, path: string): string {
  const label = relative(cwd, resolve(cwd, path));
  return label === '' ? '.' : label.split(sep).join('/');
}
