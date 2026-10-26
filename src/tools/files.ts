import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';
import {
  clip,
  displayPath,
  isProbablyBinary,
  loadIgnore,
  normalizeOutput,
  resolveWorkspacePath
} from '../core/workspace.js';
import { buildDiff } from './diff.js';

export const readTool: ToolDefinition = {
  name: 'read',
  description:
    'Read a text file from the workspace. Returns numbered lines. Use offset and limit for large files. Always read a file before editing it.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace (or absolute).' },
      offset: { type: 'number', description: '1-based line to start at. Defaults to 1.' },
      limit: { type: 'number', description: 'Maximum number of lines to return. Defaults to 2000.' }
    },
    required: ['path']
  },
  async execute(args, context): Promise<ToolResult> {
    const path = String(args.path ?? '');
    const { absolute } = resolveWorkspacePath(path, context.cwd, context.allowOutsideWorkspace);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) throw new SurfError(`File not found: ${path}`);
    if (info.isDirectory()) throw new SurfError(`${path} is a directory`, { hint: 'Use the ls tool instead.' });
    if (info.size > 2_000_000) {
      throw new SurfError(`File is too large to read (${Math.round(info.size / 1024)} KB)`, {
        hint: 'Read a smaller file or use grep to locate the relevant section.'
      });
    }
    const buffer = await readFile(absolute);
    if (isProbablyBinary(buffer)) throw new SurfError(`${path} appears to be a binary file.`);
    const content = normalizeOutput(buffer.toString('utf8'));
    const allLines = content.split('\n');
    if (allLines.at(-1) === '') allLines.pop();
    const offset = Math.max(1, Math.min(Number(args.offset) || 1, Math.max(allLines.length, 1)));
    const limit = Math.max(1, Math.min(Number(args.limit) || 2000, 5000));
    const selected = allLines.slice(offset - 1, offset - 1 + limit);
    const width = String(offset + selected.length - 1).length;
    const numbered = selected
      .map((line, index) => `${String(offset + index).padStart(width)}│ ${line.length > 4000 ? `${line.slice(0, 4000)}…` : line}`)
      .join('\n');
    const header =
      allLines.length > selected.length
        ? `${path} (lines ${offset}-${offset + selected.length - 1} of ${allLines.length})`
        : `${path} (${allLines.length} lines)`;
    return {
      output: `${header}\n${numbered}`,
      title: path,
      display: {
        kind: 'text',
        summary: `${selected.length}${selected.length !== allLines.length ? ` of ${allLines.length}` : ''} lines`,
        lines: selected.length
      }
    };
  }
};

export const writeTool: ToolDefinition = {
  name: 'write',
  description:
    'Write a complete text file, creating parent directories as needed. Overwrites existing files. For changing part of a file, prefer edit.',
  readOnly: false,
  action: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      content: { type: 'string', description: 'The complete new file content.' }
    },
    required: ['path', 'content']
  },
  async execute(args, context): Promise<ToolResult> {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    const { absolute, relative: rel } = resolveWorkspacePath(path, context.cwd, context.allowOutsideWorkspace);
    const existing = await readFile(absolute, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (existing === content) {
      return {
        output: `No changes: ${path} already has this content.`,
        title: path,
        display: { summary: 'unchanged' }
      };
    }
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    const diff = buildDiff(existing, content, relative(context.cwd, absolute));
    const summary = `+${diff.additions} −${diff.deletions}`;
    return {
      output: `Wrote ${content.length} bytes to ${path} (${summary}).`,
      title: path,
      display: {
        kind: 'diff',
        summary,
        diff: diff.patch,
        additions: diff.additions,
        deletions: diff.deletions,
        lines: content.split('\n').length
      }
    };
  }
};

export const editTool: ToolDefinition = {
  name: 'edit',
  description:
    'Replace an exact string in a file. oldString must match exactly, including whitespace. Read the file first. Use replaceAll to change every occurrence; otherwise oldString must be unique.',
  readOnly: false,
  action: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the workspace.' },
      oldString: { type: 'string', description: 'Exact text to replace.' },
      newString: { type: 'string', description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence (default false).' }
    },
    required: ['path', 'oldString', 'newString']
  },
  async execute(args, context): Promise<ToolResult> {
    const path = String(args.path ?? '');
    const oldString = String(args.oldString ?? '');
    const newString = String(args.newString ?? '');
    const replaceAll = Boolean(args.replaceAll);
    if (!oldString) throw new SurfError('oldString must not be empty.');
    const { absolute } = resolveWorkspacePath(path, context.cwd, context.allowOutsideWorkspace);
    const existing = await readFile(absolute, 'utf8').catch(() => {
      throw new SurfError(`File not found: ${path}`);
    });
    const occurrences = countOccurrences(existing, oldString);
    if (occurrences === 0) {
      throw new SurfError(`oldString was not found in ${path}`, {
        hint: 'Re-read the file and copy the exact text, including indentation. The file may also have changed.'
      });
    }
    if (!replaceAll && occurrences > 1) {
      throw new SurfError(`oldString occurs ${occurrences} times in ${path}`, {
        hint: 'Add more surrounding context to make it unique, or pass replaceAll: true.'
      });
    }
    const updated = replaceAll ? existing.split(oldString).join(newString) : existing.replace(oldString, newString);
    if (updated === existing) {
      return { output: `No changes made to ${path}.`, title: path, display: { summary: 'unchanged' } };
    }
    await writeFile(absolute, updated, 'utf8');
    const diff = buildDiff(existing, updated, path);
    const summary = `+${diff.additions} −${diff.deletions}`;
    return {
      output: `Edited ${path} (${occurrences} replacement${occurrences === 1 ? '' : 's'}, ${summary}).`,
      title: path,
      display: {
        kind: 'diff',
        summary,
        diff: diff.patch,
        additions: diff.additions,
        deletions: diff.deletions
      }
    };
  }
};

export const listTool: ToolDefinition = {
  name: 'ls',
  description: 'List files and directories in a workspace directory. Use glob to find files recursively.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path. Defaults to the workspace root.' }
    }
  },
  async execute(args, context): Promise<ToolResult> {
    const rawPath = String(args.path ?? '.');
    const { absolute } = resolveWorkspacePath(rawPath, context.cwd, context.allowOutsideWorkspace);
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => {
      throw new SurfError(`Directory not found: ${rawPath}`);
    });
    const matcher = await loadIgnore(context.cwd);
    const visible = entries
      .filter((entry) => {
        const rel = relative(context.cwd, `${absolute}/${entry.name}`).split('\\').join('/');
        return !matcher.ignores(rel) || entry.name === '.surfcodeignore';
      })
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .slice(0, 300);

    const lines: string[] = [];
    for (const entry of visible) {
      if (entry.isDirectory()) {
        lines.push(`  ${entry.name}/`);
      } else {
        const info = await stat(`${absolute}/${entry.name}`).catch(() => undefined);
        const size = info ? formatSize(info.size) : '';
        lines.push(`  ${entry.name}${size ? `  ${size}` : ''}`);
      }
    }
    const path = displayPath(context.cwd, absolute);
    return {
      output: lines.length > 0 ? `${path}/\n${lines.join('\n')}` : `${path}/ is empty.`,
      title: path,
      display: { kind: 'files', summary: `${visible.length} entries`, lines: visible.length }
    };
  }
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
