import type { ChatMessage, ResolvedModel, ResolvedProvider, ToolSchema } from '../types.js';
import type { StreamCallbacks, StreamOptions } from './common.js';

export interface ChatRequest {
  provider: ResolvedProvider;
  model: ResolvedModel;
  messages: ChatMessage[];
  system: string;
  tools: ToolSchema[];
  options: StreamOptions;
  callbacks: StreamCallbacks;
  /** Stable across transparent retries so compatible gateways can de-duplicate a request. */
  idempotencyKey?: string;
}
