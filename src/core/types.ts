export type Dialect =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'google-vertex';

/** Native reasoning effort levels understood by supported providers. */
export type Effort = 'low' | 'medium' | 'high';

/** `auto` keeps the provider's own default. */
export type EffortSetting = Effort | 'auto';

export interface CatalogCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  [key: string]: unknown;
}

export interface CatalogLimit {
  context?: number;
  input?: number;
  output?: number;
}

export interface CatalogModel {
  id: string;
  name: string;
  tool_call?: boolean;
  reasoning?: boolean;
  attachment?: boolean;
  release_date?: string;
  limit?: CatalogLimit;
  cost?: CatalogCost;
  modalities?: {
    input?: string[];
    output?: string[];
  };
}

export interface CatalogProvider {
  id: string;
  name: string;
  env: string[];
  npm?: string;
  api?: string;
  doc?: string;
  models: Record<string, CatalogModel>;
  /** Set for providers defined by the user rather than models.dev. */
  custom?: boolean;
  local?: boolean;
  /** Set for local servers that answered a model discovery request. */
  discovered?: boolean;
}

export interface ProviderSettings {
  apiKey?: string;
  baseURL?: string;
  headers?: Record<string, string>;
  dialect?: Dialect;
  apiVersion?: string;
  /** Azure deployment name. Defaults to the selected model id. */
  deployment?: string;
  /** Vertex project/location. */
  project?: string;
  location?: string;
  /** Extra fields merged into the request body. */
  extraBody?: Record<string, unknown>;
  /** Milliseconds. */
  timeout?: number;
  /** Milliseconds to wait for response headers before failing fast. */
  responseTimeout?: number;
  /** Milliseconds of stream silence before aborting. */
  idleTimeout?: number;
  /** Extra retry attempts after the first request. Defaults to 2. */
  retries?: number;
  /** Base backoff in milliseconds. Defaults to 600. */
  retryDelay?: number;
  /** Some gateways require this instead of ?key=; Google uses a header by default. */
  keyless?: boolean;
}

export interface CustomProviderConfig extends ProviderSettings {
  name: string;
  env?: string[];
  models?: Array<{
    id: string;
    name?: string;
    context?: number;
    output?: number;
    tool_call?: boolean;
    reasoning?: boolean;
  }>;
  doc?: string;
}

export type PermissionAction = 'read' | 'write' | 'shell' | 'fetch';
export type PermissionMode = 'allow' | 'ask' | 'deny';

export interface PermissionRequest {
  action: PermissionAction;
  title: string;
  detail?: string;
  /** e.g. file path or command summary */
  rule?: string;
  risk?: 'low' | 'medium' | 'high';
}

export type PermissionDecision = 'allow' | 'always' | 'deny';

export interface ResolvedProvider {
  id: string;
  name: string;
  dialect: Dialect;
  baseURL: string;
  apiKey?: string;
  headers: Record<string, string>;
  settings: ProviderSettings;
  envName?: string;
  keyless?: boolean;
}

export interface ResolvedModel {
  id: string;
  name: string;
  provider: ResolvedProvider;
  meta?: CatalogModel;
  contextWindow: number;
  maxOutput: number;
}

/** A worker model in /agent mode. The current model stays the head. */
export interface AgentWorker {
  provider: string;
  model: string;
}

/** A resolved worker ready to receive parallel delegation tasks. */
export interface AgentDelegate {
  provider: ResolvedProvider;
  model: ResolvedModel;
}

export interface AgentsConfig {
  enabled: boolean;
  workers: AgentWorker[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  rawArguments?: string;
  /** Provider-specific opaque signature (e.g. Gemini thoughtSignature). */
  signature?: string;
}

export interface ToolResult {
  output: string;
  title?: string;
  isError?: boolean;
  /** Compact UI metadata; never sent to the model. */
  display?: {
    kind?: 'diff' | 'shell' | 'text' | 'todos' | 'files' | 'search' | 'fetch';
    summary?: string;
    diff?: string;
    additions?: number;
    deletions?: number;
    lines?: number;
    truncated?: boolean;
    todos?: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  };
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface ThinkingBlock {
  type?: 'thinking' | 'redacted_thinking';
  thinking: string;
  signature?: string;
  data?: string;
}

/**
 * Ordered provider-native content that must be replayed exactly. Gemini 3
 * thought signatures can live on empty text parts, so reconstructing a request
 * from text and tool calls alone is not always enough.
 */
export interface ProviderPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: {
    name: string;
    args: Record<string, unknown>;
  };
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCall[];
  /** Opaque provider blocks that must be replayed with the message. */
  thinkingBlocks?: ThinkingBlock[];
  /** Exact provider parts, used by Gemini thought signatures. */
  providerParts?: ProviderPart[];
}

export interface ToolMessage {
  role: 'tool';
  toolCallId: string;
  name: string;
  content: string;
  isError?: boolean;
}

export type ChatMessage = UserMessage | AssistantMessage | ToolMessage;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
  requests: number;
}

export interface ChatResult {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: Partial<Usage>;
  finishReason?: string;
  thinkingBlocks?: ThinkingBlock[];
  /** Exact provider parts, used by Gemini thought signatures. */
  providerParts?: ProviderPart[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  allowOutsideWorkspace: boolean;
  planMode: boolean;
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  setTodos?(todos: TodoItem[]): void;
  getTodos?(): TodoItem[];
}

export interface ToolDefinition extends ToolSchema {
  readOnly: boolean;
  action: PermissionAction;
  /** Optional human-readable approval copy for tools whose arguments are not paths or commands. */
  permission?(args: Record<string, unknown>): {
    title?: string;
    detail?: string;
    risk?: PermissionRequest['risk'];
    rule?: string;
  };
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

export interface SessionRecord {
  version: 1;
  id: string;
  title: string;
  cwd: string;
  provider: string;
  model: string;
  mode: 'build' | 'plan';
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  usage: Usage;
}

export interface AuthStore {
  version: 1;
  keys: Record<string, string>;
}

/** Optional session sync. Provider API keys never enter this config or the sync payload. */
export interface SyncSettings {
  url?: string;
  token?: string;
  enabled: boolean;
  /** Push after each completed turn without an explicit /sync. */
  auto: boolean;
  /** Opaque server cursor from the last successful pull. */
  cursor: number;
  lastSyncAt?: number;
  deviceId?: string;
}

export interface SurfConfig {
  version: 1;
  provider?: string;
  model?: string;
  theme: string;
  mode: 'build' | 'plan';
  permissions: Record<PermissionAction, PermissionMode>;
  maxSteps: number;
  maxTokens?: number;
  temperature?: number;
  effort: EffortSetting;
  showReasoning: boolean;
  verboseTools: boolean;
  /** Paint tokens live while a reply is streaming. Off by default for speed. */
  streaming: boolean;
  /** Width in columns of the always-visible explorer dock. */
  explorerWidth: number;
  /** Bypass permission prompts and allow paths outside the workspace. */
  fullAccess: boolean;
  agents: AgentsConfig;
  allowOutsideWorkspace: boolean;
  providers: Record<string, ProviderSettings>;
  customProviders: Record<string, CustomProviderConfig>;
  sync: SyncSettings;
}
