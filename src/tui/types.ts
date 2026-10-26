import type { ChatMessage, ToolCall, ToolResult } from '../core/types.js';

export interface ToolView {
  call: ToolCall;
  result?: ToolResult;
  durationMs?: number;
  pending?: boolean;
}

export interface TimelineItem {
  id: string;
  type: 'user' | 'assistant' | 'notice';
  content: string;
  /** Text that preceded tool calls in the same turn. */
  preamble?: string;
  reasoning?: string;
  toolViews?: ToolView[];
  level?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
  modelName?: string;
}

export interface LiveMessage {
  content: string;
  /** Text that preceded the latest tool call. */
  preamble?: string;
  reasoning: string;
  tools: ToolView[];
  startedAt: number;
  thinkingStartedAt?: number;
  thinkingMs: number;
  step: number;
  phase: 'thinking' | 'writing' | 'tool';
  activeTool?: string;
}

export function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];
  let counter = 0;
  for (const message of messages) {
    if (message.role === 'user') {
      timeline.push({
        id: `item_${counter++}`,
        type: 'user',
        content: message.content
      });
      continue;
    }
    if (message.role === 'assistant') {
      const previous = timeline[timeline.length - 1];
      const target =
        previous?.type === 'assistant'
          ? previous
          : (() => {
              const item: TimelineItem = {
                id: `item_${counter++}`,
                type: 'assistant',
                content: '',
                toolViews: []
              };
              timeline.push(item);
              return item;
            })();
      if (message.content) {
        const hasTools = (message.toolCalls?.length ?? 0) > 0;
        if (hasTools) {
          target.preamble = target.preamble
            ? `${target.preamble}\n\n${message.content}`
            : message.content;
        } else {
          target.content = target.content ? `${target.content}\n\n${message.content}` : message.content;
        }
      }
      if (message.reasoning) {
        target.reasoning = target.reasoning ? `${target.reasoning}\n\n${message.reasoning}` : message.reasoning;
      }
      for (const call of message.toolCalls ?? []) {
        target.toolViews ??= [];
        if (!target.toolViews.some((view) => view.call.id === call.id)) {
          target.toolViews.push({ call });
        }
      }
      continue;
    }
    const previous = timeline[timeline.length - 1];
    if (previous?.type === 'assistant') {
      const view = previous.toolViews?.find((entry) => entry.call.id === message.toolCallId);
      if (view) {
        view.result = {
          output: message.content,
          isError: message.isError,
          display: { summary: message.isError ? 'error' : undefined }
        };
        view.pending = false;
      }
    }
  }
  return timeline;
}

export function appendAgentTimeline(
  timeline: TimelineItem[],
  newMessages: ChatMessage[],
  startedAt: number,
  modelName?: string
): TimelineItem[] {
  const grouped = timelineFromMessages(newMessages).filter((item) => item.type !== 'user');
  if (grouped.length === 0) return timeline;
  const assistant = grouped[0]!;
  assistant.durationMs = Date.now() - startedAt;
  assistant.modelName = modelName;
  return [...timeline, assistant];
}
