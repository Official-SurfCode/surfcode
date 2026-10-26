import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';
import {
  displayPath,
  filterIgnored,
  isProbablyBinary,
  loadIgnore,
  normalizeOutput,
  resolveWorkspacePath
} from '../core/workspace.js';

const BASE_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**'
];

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files by glob pattern, recursively. Examples: "**/*.ts", "src/**/*.{ts,tsx}", "**/package.json". Results are sorted and gitignore-aware.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: 'string', description: 'Directory to search from. Defaults to the workspace root.' },
      limit: { type: 'number', description: 'Maximum files to return (default 200, max 1000).' }
    },
    required: ['pattern']
  },
  async execute(args, context): Promise<ToolResult> {
    const pattern = String(args.pattern ?? '**/*');
    if (pattern.startsWith('/')) throw new SurfError('Glob patterns must be relative to the workspace.');
    const rawPath = String(args.path ?? '.');
    const { absolute, relative: searchRel } = resolveWorkspacePath(rawPath, context.cwd, context.allowOutsideWorkspace);
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isDirectory()) throw new SurfError(`Not a directory: ${rawPath}`);
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
    const matcher = await loadIgnore(context.cwd);
    const matches = await glob(pattern, {
      cwd: absolute,
      dot: false,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: BASE_IGNORES
    });
    const mapped = matches
      .map((entry) => (searchRel === '.' ? entry : `${searchRel}/${entry}`).split('\\').join('/'))
      .filter((entry) => !matcher.ignores(entry))
      .sort();
    const selected = mapped.slice(0, limit);
    return {
      output:
        mapped.length === 0
          ? `No files matched ${pattern}.`
          : `${mapped.length} match${mapped.length === 1 ? '' : 'es'}${mapped.length > selected.length ? ` (showing first ${selected.length})` : ''}:\n${selected.join('\n')}`,
      title: pattern,
      display: {
        kind: 'files',
        summary: `${mapped.length} ${mapped.length === 1 ? 'file' : 'files'}`,
        lines: mapped.length,
        truncated: mapped.length > selected.length
      }
    };
  }
};

export const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents using a regular expression. Returns file, line, column and matching line. Prefer this over reading many files. Uses ripgrep when available.',
  readOnly: true,
  action: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (or literal string when fixedStrings is true).' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
      include: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search. Default false.' },
      fixedStrings: { type: 'boolean', description: 'Treat pattern as a literal string. Default false.' },
      limit: { type: 'number', description: 'Maximum matches (default 200, max 1000).' }
    },
    required: ['pattern']
  },
  async execute(args, context): Promise<ToolResult> {
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new SurfError('A search pattern is required.');
    const rawPath = String(args.path ?? '.');
    const { absolute, relative: rel } = resolveWorkspacePath(rawPath, context.cwd, context.allowOutsideWorkspace);
    const info = await stat(absolute).catch(() => undefined);
    if (!info) throw new SurfError(`Path not found: ${rawPath}`);
    const limit = Math.max(1, Math.min(Number(args.limit) || 200, 1000));
    const include = args.include ? String(args.include) : undefined;
    const caseSensitive = Boolean(args.caseSensitive);
    const fixedStrings = Boolean(args.fixedStrings);

    try {
      new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (error) {
      if (!fixedStrings) {
        throw new SurfError(`Invalid regular expression: ${(error as Error).message}`);
      }
    }

    const rg = await runRipgrep({
      pattern,
      cwd: context.cwd,
      target: info.isDirectory() ? absolute : absolute,
      include,
      caseSensitive,
      fixedStrings,
      limit,
      signal: context.signal
    });
    if (rg !== undefined) {
      const lines = normalizeOutput(rg.stdout).split('\n').filter(Boolean);
      const trimmed = lines.slice(0, limit);
      return formatMatches(trimmed, lines.length, pattern, context.cwd, rel);
    }

    const files = info.isDirectory()
      ? await glob(include ?? '**/*', {
          cwd: absolute,
          dot: false,
          onlyFiles: true,
          followSymbolicLinks: false,
          ignore: BASE_IGNORES
        })
      : ['.'];
    const matcher = await loadIgnore(context.cwd);
    const matches: string[] = [];
    const regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    for (const file of files) {
      if (context.signal.aborted) break;
      const fileAbs = info.isDirectory() ? resolve(absolute, file) : absolute;
      const fileRel = displayPath(context.cwd, fileAbs);
      if (info.isDirectory() && matcher.ignores(file.split('\\').join('/'))) continue;
      const fileStat = await stat(fileAbs).catch(() => undefined);
      if (!fileStat?.isFile() || fileStat.size > 1_500_000) continue;
      const buffer = await readFile(fileAbs).catch(() => undefined);
      if (!buffer || isProbablyBinary(buffer)) continue;
      const content = normalizeOutput(buffer.toString('utf8'));
      const lines = content.split('\n');
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index]!;
        regex.lastIndex = 0;
        const match = regex.exec(line);
        if (match) {
          matches.push(`${fileRel}:${index + 1}:${(match.index ?? 0) + 1}: ${line.trim().slice(0, 500)}`);
        }
      }
      if (matches.length >= limit) break;
    }
    return formatMatches(matches, matches.length, pattern, context.cwd, rel);
  }
};

function formatMatches(
  lines: string[],
  total: number,
  pattern: string,
  cwd: string,
  searchPath: string
): ToolResult {
  const cleaned = lines.map((line) => {
    if (cwd === '/') return line;
    return line;
  });
  return {
    output:
      cleaned.length === 0
        ? `No matches for /${pattern}/ in ${searchPath}.`
        : `${total} match${total === 1 ? '' : 'es'} for /${pattern}/:\n${cleaned.slice(0, 200).join('\n')}${total > 200 ? `\n… ${total - 200} more` : ''}`,
    title: pattern,
    display: {
      kind: 'search',
      summary: `${total} ${total === 1 ? 'match' : 'matches'}`,
      lines: total
    }
  };
}

interface RipgrepOptions {
  pattern: string;
  cwd: string;
  target: string;
  include?: string;
  caseSensitive: boolean;
  fixedStrings: boolean;
  limit: number;
  signal: AbortSignal;
}

async function runRipgrep(
  options: RipgrepOptions
): Promise<{ stdout: string; stderr: string; code: number } | undefined> {
  const args = ['--line-number', '--column', '--no-heading', '--color', 'never', '--max-columns', '500', '--max-columns-preview'];
  if (!options.caseSensitive) args.push('--ignore-case');
  if (options.fixedStrings) args.push('--fixed-strings');
  for (const ignored of BASE_IGNORES) args.push('--glob', `!${ignored.replace('**/', '')}`);
  if (options.include) args.push('--glob', options.include);
  args.push('--', options.pattern, options.target);

  return await new Promise((resolvePromise) => {
    const child = spawn('rg', args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let missing = false;
    let settled = false;
    const finish = (value?: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      resolvePromise(value);
    };
    const abort = () => {
      child.kill('SIGTERM');
      finish(undefined);
    };
    options.signal.addEventListener('abort', abort, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') missing = true;
      finish(undefined);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 500_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      if (missing) return finish(undefined);
      finish({ stdout, stderr, code: code ?? 0 });
    });
  });
}

export function filterByIgnore(cwd: string, paths: string[]) {
  return loadIgnore(cwd).then((matcher) => filterIgnored(matcher, cwd, paths));
}
