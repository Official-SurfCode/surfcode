import { structuredPatch } from 'diff';

export interface DiffResult {
  patch: string;
  additions: number;
  deletions: number;
}

export function buildDiff(oldText: string, newText: string, path: string, context = 3): DiffResult {
  if (oldText === newText) return { patch: '', additions: 0, deletions: 0 };
  const patch = structuredPatch(path, path, oldText, newText, '', '', { context });
  let additions = 0;
  let deletions = 0;
  const lines: string[] = [];
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const line of hunk.lines) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
      lines.push(line);
    }
  }
  return { patch: lines.join('\n'), additions, deletions };
}
