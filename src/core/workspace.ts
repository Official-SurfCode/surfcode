import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { SurfError } from './errors.js';

export function resolveWorkspacePath(
  input: string,
  cwd: string,
  allowOutsideWorkspace: boolean
): { absolute: string; relative: string } {
  if (!input || input.includes('\0')) throw new SurfError('A file path is required.');
  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input);
  const rel = relative(cwd, absolute);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (outside && !allowOutsideWorkspace) {
    throw new SurfError(`Path is outside the workspace: ${input}`, {
      hint: 'Enable allowOutsideWorkspace in config, or use a path inside the project.'
    });
  }
  return { absolute, relative: rel === '' ? '.' : rel };
}

export function displayPath(cwd: string, absolute: string): string {
  const rel = relative(cwd, absolute);
  if (!rel || rel === '') return '.';
  if (rel.startsWith('..')) return absolute;
  return rel.split(sep).join('/');
}

export async function loadIgnore(cwd: string): Promise<Ignore> {
  const matcher = ignore();
  matcher.add(['.git/', 'node_modules/', 'dist/', 'build/', 'coverage/', '.next/', '.turbo/', '.cache/']);
  for (const name of ['.gitignore', '.surfcodeignore']) {
    try {
      const content = await readFile(resolve(cwd, name), 'utf8');
      matcher.add(content);
    } catch {
      // Optional.
    }
  }
  return matcher;
}

export function filterIgnored(matcher: Ignore, cwd: string, paths: string[]): string[] {
  return paths.filter((path) => {
    const normalized = path.split(sep).join('/');
    return !matcher.ignores(normalized);
  });
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1;
  }
  return control / Math.max(sample.length, 1) > 0.05;
}

export function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return {
    text: `${text.slice(0, max)}\n\n… output truncated (${text.length - max} characters omitted)`,
    truncated: true
  };
}

export function normalizeOutput(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
