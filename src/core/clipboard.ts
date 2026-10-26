import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const COMMANDS: Array<{ command: string; args: string[] }> =
  process.platform === 'darwin'
    ? [{ command: 'pbpaste', args: [] }]
    : process.platform === 'win32'
      ? [{ command: 'powershell', args: ['-NoProfile', '-Command', 'Get-Clipboard -Raw'] }]
      : [
          { command: 'wl-paste', args: ['--no-newline'] },
          { command: 'xclip', args: ['-selection', 'clipboard', '-o'] },
          { command: 'xsel', args: ['--clipboard', '--output'] }
        ];

/**
 * Read the system clipboard without adding a native dependency. Returns
 * undefined when no clipboard helper exists or the command fails.
 */
export async function readClipboard(): Promise<string | undefined> {
  for (const candidate of COMMANDS) {
    try {
      const { stdout } = await execFileAsync(candidate.command, candidate.args, {
        timeout: 1_500,
        maxBuffer: 1_000_000,
        encoding: 'utf8'
      });
      if (typeof stdout === 'string' && stdout.length > 0) return stdout;
    } catch {
      // Try the next helper.
    }
  }
  return undefined;
}
