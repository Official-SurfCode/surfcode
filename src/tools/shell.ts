import { spawn } from 'node:child_process';
import stripAnsi from 'strip-ansi';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { SurfError } from '../core/errors.js';
import { clip, normalizeOutput } from '../core/workspace.js';

export const shellTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the workspace and return combined stdout/stderr. Use for builds, tests, git, installing dependencies, and other terminal tasks. Do not run interactive commands. Output is truncated.',
  readOnly: false,
  action: 'shell',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000).' }
    },
    required: ['command']
  },
  async execute(args, context): Promise<ToolResult> {
    const command = String(args.command ?? '').trim();
    if (!command) throw new SurfError('A command is required.');
    const timeout = Math.max(1000, Math.min(Number(args.timeout) || 120_000, 600_000));
    const started = Date.now();
    const result = await runShell(command, context.cwd, timeout, context.signal);
    const duration = ((Date.now() - started) / 1000).toFixed(1);
    const combined = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
    const cleaned = stripAnsi(normalizeOutput(combined || '(no output)'));
    const clipped = clip(cleaned, 60_000);
    const exit = result.timedOut ? 'timed out' : `exit ${result.code ?? '?'}`;
    const output = `$ ${command}\n(${exit} · ${duration}s)\n${clipped.text}`;
    return {
      output,
      title: command,
      isError: result.timedOut || (result.code ?? 0) !== 0,
      display: {
        kind: 'shell',
        summary: `${result.timedOut ? 'timed out' : result.code === 0 ? 'ok' : `exit ${result.code}`} · ${duration}s`,
        lines: cleaned.split('\n').length,
        truncated: clipped.truncated
      }
    };
  }
};

interface ShellResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runShell(command: string, cwd: string, timeout: number, signal: AbortSignal): Promise<ShellResult> {
  return new Promise((resolvePromise, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, {
      cwd,
      shell: true,
      detached,
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let truncationKilled = false;

    const kill = (sig: NodeJS.Signals) => {
      try {
        if (detached && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        child.kill(sig);
      }
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolvePromise({ stdout, stderr, code, timedOut });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 800).unref();
    }, timeout);

    const onAbort = () => {
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 300).unref();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < 200_000) stdout += chunk.toString('utf8');
      else if (!truncationKilled) {
        truncationKilled = true;
        stderr += '\n(process output exceeded 200 KB and was stopped)';
        kill('SIGTERM');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 100_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(new SurfError(`Could not run command: ${error.message}`));
    });
    child.on('close', (code) => {
      if (signal.aborted && !timedOut) {
        finish(code);
        return;
      }
      finish(code);
    });
  });
}
