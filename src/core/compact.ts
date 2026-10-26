import type { ChatMessage, ResolvedModel, ResolvedProvider, Usage } from './types.js';
import { streamChat } from './chat/index.js';
import { costForUsage } from './usage.js';

export interface CompactResult {
  summary: string;
  usage: Partial<Usage>;
}

export async function compactConversation(options: {
  provider: ResolvedProvider;
  model: ResolvedModel;
  messages: ChatMessage[];
  signal: AbortSignal;
}): Promise<CompactResult> {
  const transcript = options.messages
    .map((message) => {
      if (message.role === 'tool') return `TOOL ${message.name}:\n${message.content}`;
      if (message.role === 'assistant') {
        const tools = message.toolCalls?.map((call) => `${call.name}(${JSON.stringify(call.arguments)})`).join(', ');
        return `ASSISTANT:\n${message.content}${tools ? `\nTOOL CALLS: ${tools}` : ''}`;
      }
      return `USER:\n${message.content}`;
    })
    .join('\n\n')
    .slice(-120_000);

  const result = await streamChat({
    provider: options.provider,
    model: options.model,
    messages: [
      {
        role: 'user',
        content: `Summarize this coding session so another engineer can continue the work with no other context. Preserve: the user's goals, decisions and constraints, files changed, important code locations, commands/tests run and their outcomes, open questions, and next steps. Be dense and specific. Use Markdown headings and bullets. Do not add commentary.\n\n<sessions>\n${transcript}\n</sessions>`
      }
    ],
    system: 'You are a precise technical summarizer. Output only the summary.',
    tools: [],
    options: { signal: options.signal, maxTokens: 4096 },
    callbacks: { onText: () => {}, onReasoning: () => {} }
  });

  return {
    summary: result.text.trim() || 'Earlier conversation was compacted, but the summary was empty.',
    usage: {
      ...result.usage,
      cost: costForUsage(options.model.meta, result.usage, options.provider.dialect),
      requests: 1
    }
  };
}
