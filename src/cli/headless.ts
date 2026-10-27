import { createInterface } from 'node:readline/promises';
import { runAgent } from '../core/agent.js';
import { resolveAgentWorkers } from '../core/agents.js';
import { discoverLocalModels, loadCatalog } from '../core/catalog.js';
import { loadConfig, updateConfigPath } from '../core/config.js';
import { activeEffort } from '../core/effort.js';
import { SurfError, errorMessage } from '../core/errors.js';
import { resolveSelection } from '../core/provider.js';
import { resolveSyncSettings, syncSessions } from '../core/sync.js';
import {
  addSessionUsage,
  createSession,
  latestSession,
  loadSession,
  saveSession
} from '../core/session.js';
import type {
  EffortSetting,
  PermissionDecision,
  PermissionRequest,
  SessionRecord,
  SurfConfig,
  ToolCall,
  Usage
} from '../core/types.js';
import { formatCost, formatTokens } from '../core/usage.js';
import { createTools } from '../tools/index.js';
import {
  danger,
  formatDuration,
  muted,
  oneLine,
  prepareStartup,
  safeText,
  success,
  warning,
  writeError
} from './util.js';

export interface HeadlessOptions {
  cwd: string;
  prompt?: string;
  provider?: string;
  model?: string;
  plan?: boolean;
  yes?: boolean;
  json?: boolean;
  quiet?: boolean;
  reasoning?: boolean;
  save?: boolean;
  session?: string;
  continue?: boolean;
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortSetting;
}

type JsonEvent =
  | { type: 'session'; sessionId: string; provider: string; model: string; resumed: boolean }
  | { type: 'notice'; message: string }
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_start'; id: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool_result';
      id: string;
      name: string;
      durationMs: number;
      isError: boolean;
      output: string;
    }
  | { type: 'usage'; usage: Usage }
  | {
      type: 'result';
      text: string;
      usage: Usage;
      aborted: boolean;
      sessionId?: string;
      durationMs: number;
    }
  | { type: 'error'; message: string; hint?: string };

const LOCAL_PROVIDERS = new Set(['ollama', 'llamacpp', 'vllm', 'lmstudio']);

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const json = Boolean(options.json);
  const quiet = Boolean(options.quiet) || json;
  const emit = (event: JsonEvent) => {
    if (json) process.stdout.write(`${JSON.stringify(event)}\n`);
  };

  let session: SessionRecord | undefined;
  try {
    const input = await resolvePrompt(options.prompt);
    const config = await loadConfig();
    const catalog = await loadCatalog(config);

    if (options.session && options.continue) {
      throw new SurfError('Choose either --session or --continue, not both.');
    }

    if (options.session) {
      session = await loadSession(options.session);
      if (!session) {
        throw new SurfError(`Session not found: ${options.session}`, {
          hint: 'Run `surf sessions` to list saved sessions.'
        });
      }
    } else if (options.continue) {
      session = await latestSession(options.cwd);
      if (!session) {
        throw new SurfError(`No saved sessions for ${options.cwd}`, {
          hint: 'Run `surf` to start a new session.'
        });
      }
    }

    if (shouldDiscoverLocal(options, config)) {
      await discoverLocalModels(catalog);
    }

    const startup = await prepareStartup({
      config,
      catalog,
      provider: options.provider ?? session?.provider,
      model: options.model ?? session?.model
    });

    if (startup.note && !quiet) writeError(muted(startup.note));

    const selection = await resolveSelection(catalog, startup.config, {
      provider: startup.config.provider,
      model: startup.config.model
    });
    const mode = options.plan ? 'plan' : (session?.mode ?? startup.config.mode);
    const resumed = Boolean(session);
    const activeSession: SessionRecord =
      session ??
      createSession({
        cwd: options.cwd,
        provider: selection.provider.id,
        model: selection.model.id,
        mode
      });

    session = {
      ...activeSession,
      provider: selection.provider.id,
      model: selection.model.id,
      mode
    };

    emit({
      type: 'session',
      sessionId: session.id,
      provider: selection.provider.id,
      model: selection.model.id,
      resumed
    });

    const permissions = { ...startup.config.permissions };
    if (startup.config.fullAccess) {
      for (const key of Object.keys(permissions) as Array<keyof typeof permissions>) {
        permissions[key] = 'allow';
      }
    }
    if (options.yes) {
      for (const key of Object.keys(permissions) as Array<keyof typeof permissions>) {
        if (permissions[key] === 'ask') permissions[key] = 'allow';
      }
    }

    if (!options.yes && !process.stdin.isTTY && hasAskPermission(permissions) && !quiet) {
      writeError(
        muted(
          'note: permission prompts are unavailable here; use --yes to auto-approve tool actions.'
        )
      );
    }

    const controller = new AbortController();
    let interrupts = 0;
    const onSigint = () => {
      interrupts += 1;
      if (interrupts === 1) {
        controller.abort();
        if (!quiet) writeError(muted('stopping… (ctrl+c again to exit)'));
      } else {
        process.exit(130);
      }
    };
    const onSigterm = () => {
      controller.abort();
      process.exit(143);
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    const startedAt = Date.now();
    let streamedText = '';
    let lastUsage: Usage | undefined;
    let permissionWarned = false;

    let delegates: Awaited<ReturnType<typeof resolveAgentWorkers>>['delegates'] = [];
    if (startup.config.agents.enabled && startup.config.agents.workers.length > 0) {
      const resolved = await resolveAgentWorkers(catalog, startup.config);
      delegates = resolved.delegates;
      if (!quiet && resolved.failures.length > 0) {
        writeError(warning(`worker models skipped: ${resolved.failures.join('; ')}`));
      }
    }

    try {
      const outcome = await runAgent({
        cwd: options.cwd,
        provider: selection.provider,
        model: selection.model,
        history: session.messages,
        input,
        mode,
        tools: createTools(),
        permissions,
        maxSteps: options.maxSteps ?? startup.config.maxSteps,
        maxTokens:
          options.maxTokens ??
          startup.config.maxTokens ??
          Math.min(selection.model.maxOutput || 8192, 65_536),
        temperature: options.temperature ?? startup.config.temperature,
        effort: activeEffort(options.effort ?? startup.config.effort),
        showReasoning: Boolean(options.reasoning),
        delegates,
        allowOutsideWorkspace:
          startup.config.fullAccess || startup.config.allowOutsideWorkspace,
        signal: controller.signal,
        callbacks: {
          onText(delta) {
            streamedText += delta;
            if (json) emit({ type: 'text', delta });
            else process.stdout.write(delta);
          },
          onReasoning(delta) {
            if (json && options.reasoning) emit({ type: 'reasoning', delta });
            else if (!json && options.reasoning) process.stderr.write(muted(delta));
          },
          onToolStart(call, tool) {
            if (json) {
              emit({
                type: 'tool_start',
                id: call.id,
                name: call.name,
                arguments: call.arguments
              });
              return;
            }
            if (quiet) return;
            const detail = toolDetail(call);
            process.stderr.write(
              `\n${warning('◆')} ${tool?.name ?? call.name}${detail ? ` ${muted(detail)}` : ''}\n`
            );
          },
          onToolResult(call, result, durationMs) {
            if (json) {
              emit({
                type: 'tool_result',
                id: call.id,
                name: call.name,
                durationMs,
                isError: Boolean(result.isError),
                output: result.output
              });
              return;
            }
            if (quiet) return;
            if (result.isError) {
              process.stderr.write(
                `  ${danger('✗')} ${oneLine(firstLine(result.output), 220)}\n`
              );
            } else {
              process.stderr.write(
                `  ${success('✓')} ${muted(`${call.name} · ${formatDuration(durationMs)}`)}\n`
              );
            }
          },
          onUsage(total) {
            lastUsage = total;
            if (json) emit({ type: 'usage', usage: total });
          },
          async requestPermission(request) {
            if (options.yes) return 'allow';
            if (!process.stdin.isTTY) {
              if (!permissionWarned && !quiet) {
                permissionWarned = true;
                writeError(
                  muted(
                    `denied ${request.action}: no TTY for an approval prompt (use --yes to auto-approve).`
                  )
                );
              }
              return 'deny';
            }
            const decision = await askPermission(request);
            if (decision === 'always') permissions[request.action] = 'allow';
            return decision;
          }
        }
      });

      const nextSession: SessionRecord = {
        ...session,
        messages: outcome.messages,
        usage: addSessionUsage(session.usage, outcome.usage)
      };
      session = nextSession;

      if (options.save !== false) {
        let saved = false;
        try {
          await saveSession(nextSession);
          saved = true;
        } catch (error) {
          if (!json) writeError(warning(`Could not save session: ${errorMessage(error)}`));
        }
        if (saved) {
          const sync = resolveSyncSettings(startup.config);
          if (sync.enabled && sync.auto) {
            try {
              const result = await syncSessions({ config: startup.config, direction: 'push' });
              await updateConfigPath(['sync', 'cursor'], result.cursor);
              await updateConfigPath(['sync', 'lastSyncAt'], Date.now());
            } catch (error) {
              if (!json) writeError(warning(`Could not sync session: ${errorMessage(error)}`));
            }
          }
        }
      }

      if (!json && streamedText && !streamedText.endsWith('\n')) process.stdout.write('\n');

      const durationMs = Date.now() - startedAt;
      if (json) {
        emit({
          type: 'result',
          text: streamedText,
          usage: outcome.usage,
          aborted: outcome.aborted,
          sessionId: options.save === false ? undefined : nextSession.id,
          durationMs
        });
      } else if (!quiet) {
        const usage = lastUsage ?? outcome.usage;
        writeError(
          muted(
            [
              selection.provider.id,
              selection.model.name,
              `${formatTokens(usage.inputTokens)} in`,
              `${formatTokens(usage.outputTokens)} out`,
              formatCost(usage.cost),
              formatDuration(durationMs),
              options.save === false ? 'not saved' : nextSession.id
            ].join(' · ')
          )
        );
        if (outcome.aborted) writeError(warning('stopped'));
      }

      return outcome.aborted ? 130 : 0;
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  } catch (error) {
    const message = errorMessage(error);
    const hint = error instanceof SurfError ? error.hint : undefined;
    if (json) emit({ type: 'error', message, ...(hint ? { hint } : {}) });
    else {
      writeError(`${danger('error')} ${safeText(message)}`);
      if (hint) writeError(muted(`  ${hint}`));
    }
    return error instanceof SurfError ? error.exitCode : 1;
  }
}

async function resolvePrompt(prompt?: string): Promise<string> {
  const given = prompt?.trim();
  if (given && given !== '-') return given;

  if (process.stdin.isTTY && given !== '-') {
    throw new SurfError('No prompt provided', {
      hint: 'Pass a prompt, pipe text on stdin, or run `surf` for the interactive UI.'
    });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    throw new SurfError('No prompt provided on stdin', {
      hint: 'Example: echo "explain src/index.ts" | surf run'
    });
  }
  return text;
}

function hasAskPermission(permissions: Record<string, string>): boolean {
  return Object.values(permissions).some((value) => value === 'ask');
}

function shouldDiscoverLocal(options: HeadlessOptions, config: SurfConfig): boolean {
  const ids = [options.provider, config.provider].filter(Boolean) as string[];
  if (ids.some((id) => LOCAL_PROVIDERS.has(id))) return true;
  return Object.values(config.providers).some(
    (settings) => settings?.baseURL && /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i.test(settings.baseURL)
  );
}

function toolDetail(call: ToolCall): string {
  const args = call.arguments;
  const value =
    args.command ?? args.path ?? args.pattern ?? args.url ?? args.query ?? args.file ?? args.content;
  return typeof value === 'string' ? oneLine(value.replace(/\n/g, ' '), 110) : '';
}

function firstLine(value: string): string {
  return value.split('\n').find((line) => line.trim()) ?? value;
}

async function askPermission(request: PermissionRequest): Promise<PermissionDecision> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const detail = request.detail ? `\n  ${muted(oneLine(request.detail, 200))}` : '';
    const risk = request.risk ? ` ${muted(`[${request.risk} risk]`)}` : '';
    const answer = (
      await rl.question(
        `\n${warning('permission')} ${request.title}${risk}${detail}\n  allow? [y]es / [a]lways / [n]o › `
      )
    )
      .trim()
      .toLowerCase();
    if (answer === 'a' || answer === 'always') return 'always';
    if (answer === 'y' || answer === 'yes' || answer === '') return 'allow';
    return 'deny';
  } finally {
    rl.close();
  }
}
