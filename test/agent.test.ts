import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { runAgent, type AgentCallbacks, type AgentOptions } from '../src/core/agent.js';
import { SurfError } from '../src/core/errors.js';
import type {
  ChatMessage,
  ResolvedModel,
  ResolvedProvider,
  ToolDefinition
} from '../src/core/types.js';

const servers: Server[] = [];
const bodies: Array<Record<string, any>> = [];
let cwd = '';

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'surfcode-agent-'));
});

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  if (cwd) await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, any>) => void
): Promise<string> {
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    let body: Record<string, any> = {};
    try {
      body = JSON.parse(raw || '{}') as Record<string, any>;
    } catch {
      // Leave an empty body for malformed test payloads.
    }
    bodies.push(body);
    handler(request, response, body);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function sse(response: ServerResponse, events: string[]): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const data of events) response.write(`data: ${data}\n\n`);
  response.end();
}

function contentChunk(content: string, finishReason: string | null = null): string {
  return JSON.stringify({
    choices: [{ delta: content ? { content } : {}, finish_reason: finishReason }]
  });
}

function providerFor(
  id: string,
  name: string,
  dialect: ResolvedProvider['dialect'],
  baseURL: string
): ResolvedProvider {
  return {
    id,
    name,
    dialect,
    baseURL,
    apiKey: 'test-key',
    headers: { authorization: 'Bearer test-key' },
    settings: { retries: 1, retryDelay: 1 },
    keyless: false
  };
}

function modelFor(provider: ResolvedProvider, id: string): ResolvedModel {
  return {
    id,
    name: id,
    provider,
    contextWindow: 128_000,
    maxOutput: 8_192,
    meta: { id, name: id, tool_call: true, reasoning: true }
  };
}

interface Events {
  text: string[];
  reasoning: string[];
  tools: string[];
}

function callbacks(events: Events): AgentCallbacks {
  return {
    onText(delta) {
      events.text.push(delta);
    },
    onReasoning(delta) {
      events.reasoning.push(delta);
    },
    onToolStart(call) {
      events.tools.push(`start:${call.name}`);
    },
    onToolResult(call) {
      events.tools.push(`result:${call.name}`);
    },
    onUsage() {},
    onStep() {},
    async requestPermission() {
      return 'allow';
    }
  };
}

function options(
  provider: ResolvedProvider,
  model: ResolvedModel,
  input: string,
  events: Events,
  overrides: Partial<AgentOptions> = {}
): AgentOptions {
  return {
    cwd,
    provider,
    model,
    history: [],
    input,
    mode: 'build',
    tools: [],
    permissions: { read: 'allow', write: 'allow', shell: 'allow', fetch: 'allow' },
    maxSteps: 3,
    maxTokens: 4_096,
    allowOutsideWorkspace: false,
    signal: new AbortController().signal,
    callbacks: callbacks(events),
    ...overrides
  };
}

test('a transient empty 200 reply is retried inside the same turn', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    if (calls === 1) {
      sse(response, [contentChunk('', 'stop'), '[DONE]']);
      return;
    }
    sse(response, [contentChunk('Recovered answer.', 'stop'), '[DONE]']);
  });
  const provider = providerFor('mock-agent', 'Mock Agent', 'openai', baseURL);
  const model = modelFor(provider, 'mock-model');
  const events: Events = { text: [], reasoning: [], tools: [] };

  const outcome = await runAgent(options(provider, model, 'answer me', events));

  assert.equal(calls, 2);
  assert.equal(outcome.messages.at(-1)?.role, 'assistant');
  assert.equal(outcome.messages.at(-1)?.content, 'Recovered answer.');
  assert.deepEqual(events.text, ['Recovered answer.']);
});

test('a persistent empty reply fails with an actionable error', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    sse(response, [contentChunk('', 'stop'), '[DONE]']);
  });
  const provider = providerFor('mock-agent', 'Mock Agent', 'openai', baseURL);
  const model = modelFor(provider, 'mock-model');
  const events: Events = { text: [], reasoning: [], tools: [] };

  await assert.rejects(
    () => runAgent(options(provider, model, 'answer me', events)),
    (error: unknown) => {
      assert.ok(error instanceof SurfError);
      assert.match(error.message, /Mock Agent returned an empty reply/i);
      assert.match(error.message, /finish reason: stop/i);
      assert.match(error.hint ?? '', /switch models|try again/i);
      return true;
    }
  );
  assert.equal(calls, 2);
});

test('Google MAX_TOKENS without visible text produces a visible explanation', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    sse(response, [
      JSON.stringify({
        candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 120,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 96
        }
      })
    ]);
  });
  const provider = providerFor('google-agent', 'Google Agent', 'google', baseURL);
  provider.headers = { 'x-goog-api-key': 'test-key' };
  const model = modelFor(provider, 'gemini-agent');
  const events: Events = { text: [], reasoning: [], tools: [] };

  const outcome = await runAgent(options(provider, model, 'think hard', events));

  assert.equal(calls, 1);
  assert.equal(outcome.usage.reasoningTokens, 96);
  const assistant = outcome.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.match(assistant[0]!.content, /output limit/i);
  assert.doesNotMatch(assistant[0]!.content, /^_?$/);
  assert.deepEqual(events.text, []);
});

test('a reasoning-only reply is not left as an empty answer', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    sse(response, [
      JSON.stringify({
        choices: [{ delta: { reasoning_content: 'hidden chain' }, finish_reason: null }]
      }),
      contentChunk('', 'stop'),
      '[DONE]'
    ]);
  });
  const provider = providerFor('mock-agent', 'Mock Agent', 'openai', baseURL);
  const model = modelFor(provider, 'mock-model');
  const events: Events = { text: [], reasoning: [], tools: [] };

  const outcome = await runAgent(options(provider, model, 'answer me', events));

  assert.equal(calls, 1);
  assert.deepEqual(events.reasoning, ['hidden chain']);
  const assistant = outcome.messages.filter((message) => message.role === 'assistant');
  assert.equal(assistant.length, 2);
  assert.equal(assistant[0]!.content, '');
  assert.equal(assistant[0]!.reasoning, 'hidden chain');
  assert.match(assistant[1]!.content, /only hidden reasoning/i);
});

test('consecutive turns keep the previous answer in history', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    sse(response, [contentChunk(calls === 1 ? 'first answer' : 'second answer', 'stop'), '[DONE]']);
  });
  const provider = providerFor('mock-agent', 'Mock Agent', 'openai', baseURL);
  const model = modelFor(provider, 'mock-model');
  const firstEvents: Events = { text: [], reasoning: [], tools: [] };
  const first = await runAgent(options(provider, model, 'first question', firstEvents));

  const secondEvents: Events = { text: [], reasoning: [], tools: [] };
  const second = await runAgent(
    options(provider, model, 'second question', secondEvents, { history: first.messages })
  );

  assert.equal(calls, 2);
  const answers = second.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content);
  assert.deepEqual(answers, ['first answer', 'second answer']);
  assert.deepEqual(secondEvents.text, ['second answer']);

  const sent = bodies.at(-1)?.messages as Array<Record<string, unknown>>;
  assert.ok(sent.some((message) => message.role === 'user' && message.content === 'first question'));
  assert.ok(sent.some((message) => message.role === 'assistant' && message.content === 'first answer'));
});

test('a tool round executes the tool and finishes on the next model step', async () => {
  let calls = 0;
  const baseURL = await serve((_request, response) => {
    calls += 1;
    if (calls === 1) {
      sse(response, [
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_echo',
                    type: 'function',
                    function: { name: 'echo', arguments: '{"value":"hi"}' }
                  }
                ]
              },
              finish_reason: 'tool_calls'
            }
          ]
        }),
        '[DONE]'
      ]);
      return;
    }
    sse(response, [contentChunk('Tool finished.', 'stop'), '[DONE]']);
  });
  const provider = providerFor('mock-agent', 'Mock Agent', 'openai', baseURL);
  const model = modelFor(provider, 'mock-model');
  const events: Events = { text: [], reasoning: [], tools: [] };
  let executed = 0;
  const echo: ToolDefinition = {
    name: 'echo',
    description: 'Echo a value',
    parameters: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value']
    },
    readOnly: true,
    action: 'read',
    async execute(args) {
      executed += 1;
      return { output: `echo:${String(args.value)}` };
    }
  };

  const outcome = await runAgent(
    options(provider, model, 'use the echo tool', events, { tools: [echo] })
  );

  assert.equal(calls, 2);
  assert.equal(executed, 1);
  assert.deepEqual(events.tools, ['start:echo', 'result:echo']);
  const toolMessage = outcome.messages.find((message) => message.role === 'tool');
  assert.equal(toolMessage?.content, 'echo:hi');
  assert.equal(outcome.messages.at(-1)?.content, 'Tool finished.');

  const sent = bodies.at(-1)?.messages as Array<Record<string, unknown>>;
  assert.ok(sent.some((message) => message.role === 'tool' && message.content === 'echo:hi'));
});

test('the agent records the exact Gemini signed parts in assistant history', async () => {
  const baseURL = await serve((_request, response) => {
    sse(response, [
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                { text: '', thoughtSignature: 'sig-empty' },
                { functionCall: { name: 'read', args: { path: 'hello.txt' } } }
              ]
            },
            finishReason: 'STOP'
          }
        ]
      })
    ]);
  });
  const provider = providerFor('google-agent', 'Google Agent', 'google', baseURL);
  provider.headers = { 'x-goog-api-key': 'test-key' };
  const model = modelFor(provider, 'gemini-agent');
  const events: Events = { text: [], reasoning: [], tools: [] };
  const read: ToolDefinition = {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    readOnly: true,
    action: 'read',
    async execute() {
      return { output: 'hello' };
    }
  };

  const outcome = await runAgent(
    options(provider, model, 'read hello.txt', events, { tools: [read], maxSteps: 1 })
  );
  const assistant = outcome.messages.find(
    (message): message is ChatMessage & { role: 'assistant' } =>
      message.role === 'assistant' && Boolean(message.toolCalls?.length)
  );
  assert.deepEqual(assistant?.providerParts, [
    { text: '', thoughtSignature: 'sig-empty' },
    { functionCall: { name: 'read', args: { path: 'hello.txt' } } }
  ]);
});
