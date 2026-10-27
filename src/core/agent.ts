import type {
  AgentDelegate,
  ChatMessage,
  Effort,
  PermissionAction,
  PermissionMode,
  PermissionRequest,
  ResolvedModel,
  ResolvedProvider,
  ToolCall,
  ToolDefinition,
  ToolResult,
  TodoItem,
  Usage
} from './types.js';
import { addUsage, costForUsage, emptyUsage } from './usage.js';
import { buildSystemPrompt } from './prompt.js';
import { streamChat } from './chat/index.js';
import { emptyReplyError, isLengthFinishReason } from './chat/common.js';
import { createDelegateTool } from './delegate.js';
import { isAbortError, SurfError } from './errors.js';
import { findTool, toolSchemas } from '../tools/index.js';

export interface AgentCallbacks {
  onText(delta: string): void;
  onReasoning(delta: string): void;
  onToolStart(call: ToolCall, tool: ToolDefinition | undefined): void;
  onToolResult(call: ToolCall, result: ToolResult, durationMs: number): void;
  onUsage(total: Usage): void;
  onTodos?(todos: TodoItem[]): void;
  onStep?(step: number, maxSteps: number): void;
  requestPermission(request: PermissionRequest): Promise<'allow' | 'always' | 'deny'>;
}

export interface AgentOptions {
  cwd: string;
  provider: ResolvedProvider;
  model: ResolvedModel;
  history: ChatMessage[];
  input: string;
  mode: 'build' | 'plan';
  tools: ToolDefinition[];
  permissions: Record<PermissionAction, PermissionMode>;
  maxSteps: number;
  maxTokens: number;
  temperature?: number;
  effort?: Effort;
  /** Ask the provider to return thought summaries. */
  showReasoning?: boolean;
  /** Worker models for /agent mode. */
  delegates?: AgentDelegate[];
  allowOutsideWorkspace: boolean;
  signal: AbortSignal;
  callbacks: AgentCallbacks;
}

export interface AgentOutcome {
  messages: ChatMessage[];
  usage: Usage;
  aborted: boolean;
}

export async function runAgent(options: AgentOptions): Promise<AgentOutcome> {
  const {
    cwd,
    provider,
    model,
    mode,
    tools,
    callbacks,
    permissions,
    maxSteps,
    signal
  } = options;
  let messages: ChatMessage[] = [...options.history];
  const userMessage: ChatMessage = { role: 'user', content: options.input.trim() };
  if (!userMessage.content) throw new SurfError('The prompt is empty.');
  messages.push(userMessage);

  const toolsEnabled = model.meta?.tool_call !== false;
  const usage = emptyUsage();
  const activeTools = [...tools];
  const delegateWorkers = options.delegates?.map(
    (delegate) => `${delegate.provider.id}/${delegate.model.id}`
  ) ?? [];
  if (toolsEnabled && options.delegates?.length) {
    activeTools.push(
      createDelegateTool({
        delegates: options.delegates,
        getHistory: () => messages,
        signal,
        cwd,
        maxTokens: options.maxTokens,
        temperature: options.temperature,
        effort: options.effort,
        onUsage(delta) {
          addUsage(usage, delta);
          callbacks.onUsage({ ...usage });
        }
      })
    );
  }
  const system = await buildSystemPrompt({
    cwd,
    mode,
    modelName: model.name,
    providerName: provider.name,
    toolsEnabled,
    effort: options.effort,
    agentWorkers: delegateWorkers
  });
  const schemas = toolsEnabled ? toolSchemas(activeTools) : [];
  let aborted = false;
  let todos: TodoItem[] = [];

  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal.aborted) {
      aborted = true;
      break;
    }
    callbacks.onStep?.(step, maxSteps);

    let partialText = '';
    let partialReasoning = '';
    let result: Awaited<ReturnType<typeof streamChat>>;
    try {
      result = await streamChat({
        provider,
        model,
        messages,
        system,
        tools: schemas,
        options: {
          signal,
          maxTokens: options.maxTokens,
          temperature: options.temperature,
          effort: options.effort,
          showReasoning: options.showReasoning,
          timeout: provider.settings.timeout
        },
        callbacks: {
          onText: (delta) => {
            partialText += delta;
            callbacks.onText(delta);
          },
          onReasoning: (delta) => {
            partialReasoning += delta;
            callbacks.onReasoning(delta);
          }
        }
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        aborted = true;
        if (partialText || partialReasoning) {
          messages.push({
            role: 'assistant',
            content: partialText,
            ...(partialReasoning ? { reasoning: partialReasoning } : {})
          });
        }
        break;
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new SurfError('The provider did not finish the request in time and it was aborted.', {
          hint: 'Try again, switch models with /model, or raise providers.<id>.settings.timeout in the config.',
          cause: error,
          retryable: true
        });
      }
      throw error;
    }

    const turnUsage: Usage = {
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
      reasoningTokens: result.usage.reasoningTokens ?? 0,
      cacheReadTokens: result.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: result.usage.cacheWriteTokens ?? 0,
      cost: costForUsage(model.meta, result.usage, provider.dialect),
      requests: 1
    };
    addUsage(usage, turnUsage);
    callbacks.onUsage({ ...usage });

    if (result.text || result.reasoning || result.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: result.text,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
        ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        ...(result.thinkingBlocks?.length ? { thinkingBlocks: result.thinkingBlocks } : {}),
        ...(result.providerParts?.length ? { providerParts: result.providerParts } : {})
      });
    }

    if (result.toolCalls.length === 0) {
      const hasText = result.text.trim().length > 0;
      if (!hasText && isLengthFinishReason(result.finishReason)) {
        // Gemini counts thinking tokens against maxOutputTokens and can hit
        // MAX_TOKENS before producing a single visible token. Say so instead
        // of ending the turn with an empty assistant bubble.
        messages.push({
          role: 'assistant',
          content: result.reasoning
            ? '_The model hit the output limit while thinking and returned no answer. Ask me to continue, lower /effort, or raise maxTokens._'
            : '_Response reached the output limit before an answer was written. Ask me to continue, lower /effort, or raise maxTokens._'
        });
      } else if (!hasText && result.reasoning.trim()) {
        messages.push({
          role: 'assistant',
          content: '_The model returned only hidden reasoning and no answer. Try again, lower /effort, or switch models with /model._'
        });
      } else if (!hasText) {
        throw emptyReplyError(provider.name, result.finishReason);
      } else if (isLengthFinishReason(result.finishReason)) {
        messages.push({
          role: 'assistant',
          content: '_Response reached the output limit. Ask me to continue if you need the rest._'
        });
      }
      break;
    }

    for (let index = 0; index < result.toolCalls.length; index += 1) {
      const call = result.toolCalls[index]!;
      if (signal.aborted) {
        aborted = true;
        for (const remaining of result.toolCalls.slice(index)) {
          const cancelled: ToolResult = { output: 'Cancelled by user.', isError: true };
          callbacks.onToolStart(remaining, findTool(activeTools, remaining.name));
          callbacks.onToolResult(remaining, cancelled, 0);
          messages.push({
            role: 'tool',
            toolCallId: remaining.id,
            name: remaining.name,
            content: cancelled.output,
            isError: true
          });
        }
        break;
      }

      const tool = findTool(activeTools, call.name);
      callbacks.onToolStart(call, tool);
      const started = Date.now();
      let toolResult: ToolResult;
      try {
        if (call.rawArguments && Object.keys(call.arguments).length === 0) {
          toolResult = {
            output: `Invalid JSON arguments for ${call.name}: ${call.rawArguments.slice(0, 500)}`,
            isError: true
          };
        } else if (!tool) {
          toolResult = {
            output: `Unknown tool: ${call.name}. Available tools: ${activeTools.map((entry) => entry.name).join(', ')}.`,
            isError: true
          };
        } else {
          toolResult = await executeWithPermission(call, tool, options, permissions, mode, callbacks, todos, (next) => {
            todos = next;
            callbacks.onTodos?.(next);
          });
        }
      } catch (error) {
        if (signal.aborted || isAbortError(error)) {
          toolResult = { output: 'Cancelled by user.', isError: true };
          aborted = true;
        } else {
          toolResult = {
            output: error instanceof Error ? error.message : String(error),
            isError: true
          };
        }
      }
      const duration = Date.now() - started;
      callbacks.onToolResult(call, toolResult, duration);
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: toolResult.output,
        ...(toolResult.isError ? { isError: true } : {})
      });
      if (aborted) break;
    }

    if (aborted) break;
    if (step === maxSteps) {
      messages.push({
        role: 'assistant',
        content: `_Stopped after ${maxSteps} tool steps. Ask me to continue, or raise maxSteps in the config._`
      });
    }
  }

  return { messages, usage, aborted };
}

async function executeWithPermission(
  call: ToolCall,
  tool: ToolDefinition,
  options: AgentOptions,
  permissions: Record<PermissionAction, PermissionMode>,
  mode: 'build' | 'plan',
  callbacks: AgentCallbacks,
  todos: TodoItem[],
  setTodos: (todos: TodoItem[]) => void
): Promise<ToolResult> {
  const permission = buildPermissionRequest(call, tool);
  if (mode === 'plan' && !tool.readOnly) {
    return {
      output: `Plan mode blocked ${tool.name}. Switch to build mode to make changes.`,
      isError: true,
      display: { summary: 'blocked by plan mode' }
    };
  }

  const policy = permissions[tool.action] ?? 'ask';
  if (policy === 'deny') {
    return {
      output: `Permission denied by policy for ${tool.action}.`,
      isError: true,
      display: { summary: 'denied by policy' }
    };
  }
  if (policy === 'ask') {
    const decision = await callbacks.requestPermission(permission);
    if (decision === 'deny') {
      return {
        output: 'Permission denied by user. Do not retry this exact action.',
        isError: true,
        display: { summary: 'denied' }
      };
    }
  }

  const context = {
    cwd: options.cwd,
    signal: options.signal,
    allowOutsideWorkspace: options.allowOutsideWorkspace,
    planMode: mode === 'plan',
    requestPermission: async () => 'allow' as const,
    setTodos,
    getTodos: () => todos
  };
  return await tool.execute(call.arguments, context);
}

function buildPermissionRequest(call: ToolCall, tool: ToolDefinition): PermissionRequest {
  const path = typeof call.arguments.path === 'string' ? call.arguments.path : undefined;
  const command = typeof call.arguments.command === 'string' ? call.arguments.command : undefined;
  const url = typeof call.arguments.url === 'string' ? call.arguments.url : undefined;
  let request: PermissionRequest;
  if (tool.action === 'shell') {
    const risk = riskyCommand(command ?? '') ? 'high' : 'medium';
    request = {
      action: 'shell',
      title: 'Run shell command',
      detail: command,
      risk,
      rule: command
    };
  } else if (tool.action === 'write') {
    request = {
      action: 'write',
      title: tool.name === 'edit' ? 'Edit file' : 'Write file',
      detail: path,
      risk: 'medium',
      rule: path
    };
  } else if (tool.action === 'fetch') {
    request = { action: 'fetch', title: 'Fetch URL', detail: url, risk: 'low', rule: url };
  } else {
    request = {
      action: 'read',
      title: tool.name === 'read' ? 'Read file' : tool.name,
      detail: path ?? url ?? (typeof call.arguments.pattern === 'string' ? call.arguments.pattern : undefined),
      risk: 'low',
      rule: path
    };
  }
  const custom = tool.permission?.(call.arguments);
  return custom ? { ...request, ...custom } : request;
}

function riskyCommand(command: string): boolean {
  return /(\brm\s+-[a-z]*r|\bsudo\b|\bmkfs\b|\bdd\s+if=|\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)|\bcurl\b[^|]*\|\s*(ba)?sh|\bchmod\s+-R\s+777|\bkillall\b|\bshutdown\b|\breboot\b)/i.test(
    command
  );
}
