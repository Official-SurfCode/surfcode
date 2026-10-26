import { streamChat } from './chat/index.js';
import { costForUsage } from './usage.js';
import type {
  AgentDelegate,
  ChatMessage,
  Effort,
  ToolDefinition,
  ToolResult,
  Usage
} from './types.js';

export interface DelegateToolOptions {
  delegates: AgentDelegate[];
  /** Read lazily so the head model sees the latest turn and tool results. */
  getHistory: () => ChatMessage[];
  signal: AbortSignal;
  cwd: string;
  maxTokens: number;
  temperature?: number;
  effort?: Effort;
  onUsage?(delta: Partial<Usage>): void;
}

interface DelegateTask {
  worker?: string;
  task: string;
}

const MAX_TASKS = 8;
const MAX_WORKER_OUTPUT = 6_000;
const MAX_CONTEXT_CHARS = 16_000;

export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const labels = options.delegates.map((delegate) => `${delegate.provider.id}/${delegate.model.id}`);
  return {
    name: 'delegate',
    description:
      'Run independent subtasks in parallel on the configured worker models, then return their answers to you. ' +
      'Workers have no tools and cannot edit files. Use this for reviews, research, debugging hypotheses, or comparing approaches. ' +
      `Available workers: ${labels.join(', ')}.`,
    readOnly: true,
    action: 'read',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: `1-${MAX_TASKS} independent tasks. All start at the same time.`,
          items: {
            type: 'object',
            properties: {
              worker: {
                type: 'string',
                description: `Optional worker id (${labels.join(', ')}). Omit to assign automatically.`
              },
              task: {
                type: 'string',
                description: 'A self-contained instruction for one worker model.'
              }
            },
            required: ['task']
          }
        }
      },
      required: ['tasks']
    },
    async execute(args): Promise<ToolResult> {
      const started = Date.now();
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks: Array<{ delegate: AgentDelegate; task: string }> = [];

      for (const [index, entry] of rawTasks.slice(0, MAX_TASKS).entries()) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        const task = String(record.task ?? '').trim();
        if (!task) continue;
        const requested = typeof record.worker === 'string' ? record.worker.trim() : '';
        const delegate = requested
          ? matchWorker(options.delegates, requested)
          : options.delegates[index % options.delegates.length];
        if (!delegate) {
          tasks.push({
            delegate: options.delegates[index % options.delegates.length]!,
            task: `[worker "${requested}" was not found; answer this anyway]\n${task}`
          });
          continue;
        }
        tasks.push({ delegate, task });
      }

      if (tasks.length === 0) {
        return {
          output: 'No delegation tasks were provided.',
          isError: true,
          display: { summary: 'no tasks' }
        };
      }

      const context = compactHistory(options.getHistory());
      const results = await Promise.allSettled(
        tasks.map(({ delegate, task }) => runWorker(options, delegate, task, context))
      );

      const blocks: string[] = [];
      let succeeded = 0;
      let failed = 0;
      for (const [index, result] of results.entries()) {
        const { delegate, task } = tasks[index]!;
        const label = `${delegate.provider.id}/${delegate.model.id}`;
        if (result.status === 'fulfilled') {
          succeeded += 1;
          const text = result.value.text.trim() || '(the worker returned no text)';
          blocks.push(`### ${label}\n${clip(text, MAX_WORKER_OUTPUT)}`);
        } else {
          failed += 1;
          const reason =
            result.reason instanceof Error ? result.reason.message : String(result.reason);
          blocks.push(`### ${label}\n_Worker failed: ${clip(reason, 800)}_\n\nTask: ${clip(task, 500)}`);
        }
      }

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      return {
        output: blocks.join('\n\n'),
        title: 'delegate',
        isError: succeeded === 0,
        display: {
          kind: 'text',
          summary: `${succeeded} worker${succeeded === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''} · ${seconds}s`,
          lines: succeeded
        }
      };
    }
  };
}

async function runWorker(
  options: DelegateToolOptions,
  delegate: AgentDelegate,
  task: string,
  context: string
): Promise<{ text: string; usage: Usage }> {
  const system = `You are a worker model inside SurfCode's multi-model /agent mode.
The head model is coordinating several workers in parallel. Answer only the task you were given.
You have NO tools: do not read files, run commands, or claim that you did.
Use the conversation context below, be specific, and return GitHub-flavored Markdown.
Keep the answer focused and under 500 words unless the task genuinely needs more.

Workspace: ${options.cwd}
Worker: ${delegate.provider.name} / ${delegate.model.name}`;

  const messages: ChatMessage[] = [
    ...(context ? [{ role: 'user' as const, content: `Conversation context:\n\n${context}` }] : []),
    { role: 'user', content: task }
  ];

  const result = await streamChat({
    provider: delegate.provider,
    model: delegate.model,
    messages,
    system,
    tools: [],
    options: {
      signal: options.signal,
      maxTokens: Math.min(options.maxTokens, 8_192),
      temperature: options.temperature,
      effort: options.effort,
      showReasoning: false,
      timeout: delegate.provider.settings.timeout
    },
    callbacks: {
      onText() {},
      onReasoning() {}
    }
  });

  const usage: Usage = {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    reasoningTokens: result.usage.reasoningTokens ?? 0,
    cacheReadTokens: result.usage.cacheReadTokens ?? 0,
    cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
    cost: costForUsage(delegate.model.meta, result.usage, delegate.provider.dialect),
    requests: 1
  };
  options.onUsage?.(usage);
  return { text: result.text, usage };
}

function matchWorker(delegates: AgentDelegate[], reference: string): AgentDelegate | undefined {
  const wanted = reference.toLowerCase();
  return delegates.find((delegate) => {
    const id = `${delegate.provider.id}/${delegate.model.id}`.toLowerCase();
    return (
      id === wanted ||
      delegate.model.id.toLowerCase() === wanted ||
      delegate.provider.id.toLowerCase() === wanted ||
      delegate.model.name.toLowerCase() === wanted
    );
  });
}

function compactHistory(messages: ChatMessage[]): string {
  const blocks: string[] = [];
  let total = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      blocks.push(`User: ${clip(message.content, 2_000)}`);
    } else if (message.role === 'assistant') {
      if (message.content) blocks.push(`Assistant: ${clip(message.content, 2_000)}`);
      for (const call of message.toolCalls ?? []) {
        blocks.push(`Assistant called ${call.name}(${clip(JSON.stringify(call.arguments), 600)})`);
      }
    } else {
      blocks.push(
        `Tool ${message.name}${message.isError ? ' (error)' : ''}: ${clip(message.content, 1_200)}`
      );
    }
    total += blocks.at(-1)!.length;
    if (total >= MAX_CONTEXT_CHARS) break;
  }
  return blocks.reverse().join('\n\n').slice(-MAX_CONTEXT_CHARS);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
