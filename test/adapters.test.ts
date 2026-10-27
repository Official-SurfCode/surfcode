import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, test } from 'node:test';
import { azureChatUrl, streamChat } from '../src/core/chat/index.js';
import type { ChatRequest } from '../src/core/chat/types.js';
import { SurfError } from '../src/core/errors.js';
import type { ResolvedModel, ResolvedProvider } from '../src/core/types.js';

interface Captured {
  url?: string;
  headers?: IncomingMessage['headers'];
  body?: Record<string, any>;
}

const servers: Server[] = [];
const captured: Captured[] = [];

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function serve(
  handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, any>) => void | Promise<void>
): Promise<string> {
  const record: Captured = {};
  captured.push(record);
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    try {
      record.body = JSON.parse(raw || '{}') as Record<string, any>;
    } catch {
      record.body = {};
    }
    record.url = request.url;
    record.headers = request.headers;
    await handler(request, response, record.body ?? {});
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function providerFor(
  id: string,
  dialect: ResolvedProvider['dialect'],
  baseURL: string,
  headers: Record<string, string>
): ResolvedProvider {
  return {
    id,
    name: id,
    dialect,
    baseURL,
    apiKey: 'test-key',
    headers,
    settings: {},
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
    meta: { id, name: id, tool_call: true }
  };
}

function requestFor(
  provider: ResolvedProvider,
  model: ResolvedModel,
  overrides: Partial<ChatRequest> = {}
): { request: ChatRequest; text: string[]; reasoning: string[] } {
  const text: string[] = [];
  const reasoning: string[] = [];
  return {
    text,
    reasoning,
    request: {
      provider,
      model,
      messages: [{ role: 'user', content: 'read hello.txt' }],
      system: 'You are a test agent.',
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }
      ],
      options: { signal: new AbortController().signal, maxTokens: 1024 },
      callbacks: {
        onText: (delta) => text.push(delta),
        onReasoning: (delta) => reasoning.push(delta)
      },
      ...overrides
    }
  };
}

function sse(response: ServerResponse, events: Array<{ event?: string; data: string }>): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  for (const entry of events) {
    if (entry.event) response.write(`event: ${entry.event}\n`);
    response.write(`data: ${entry.data}\n\n`);
  }
  response.end();
}

describe('streaming dialects', () => {
  test('Anthropic streams text, thinking, tool use, and cache usage', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        {
          event: 'message_start',
          data: JSON.stringify({
            type: 'message_start',
            message: {
              usage: {
                input_tokens: 100,
                output_tokens: 1,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 5
              }
            }
          })
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: 'I will ' }
          })
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'read it.' }
          })
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', thinking: 'Need the file ' }
          })
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'thinking_delta', thinking: 'first.' }
          })
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 2,
            content_block: { type: 'tool_use', id: 'toolu_1', name: 'read', input: {} }
          })
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"path":"hello.txt"}' }
          })
        },
        {
          event: 'message_delta',
          data: JSON.stringify({
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 12 }
          })
        },
        { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) }
      ]);
    });
    const provider = providerFor('anthropic', 'anthropic', baseURL, {
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01'
    });
    const model = modelFor(provider, 'claude-test');
    const { request, text, reasoning } = requestFor(provider, model);
    const result = await streamChat(request);

    const sent = captured.at(-1)!;
    assert.equal(sent.url, '/v1/messages');
    assert.equal(sent.headers?.['x-api-key'], 'test-key');
    assert.equal(sent.headers?.['anthropic-version'], '2023-06-01');
    assert.equal(sent.body?.stream, true);
    assert.equal(sent.body?.tools?.[0]?.name, 'read');
    assert.equal(result.text, 'I will read it.');
    assert.equal(result.reasoning, 'Need the file first.');
    assert.equal(result.finishReason, 'tool_use');
    assert.deepEqual(result.toolCalls[0]?.arguments, { path: 'hello.txt' });
    assert.equal(result.toolCalls[0]?.id, 'toolu_1');
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 12);
    assert.equal(result.usage.cacheReadTokens, 20);
    assert.equal(result.usage.cacheWriteTokens, 5);
    assert.deepEqual(text, ['I will ', 'read it.']);
    assert.deepEqual(reasoning, ['Need the file ', 'first.']);
  });

  test('Google streams text, function calls, and usage metadata', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        {
          data: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: 'Let me look.' }, { text: 'Thinking.', thought: true }]
                }
              }
            ]
          })
        },
        {
          data: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'read', args: { path: 'hello.txt' } } }]
                },
                finishReason: 'STOP'
              }
            ],
            usageMetadata: {
              promptTokenCount: 72,
              candidatesTokenCount: 9,
              thoughtsTokenCount: 4,
              cachedContentTokenCount: 8
            }
          })
        }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    const model = modelFor(provider, 'gemini-test');
    const { request, text, reasoning } = requestFor(provider, model);
    const result = await streamChat(request);

    const sent = captured.at(-1)!;
    assert.equal(sent.url, '/models/gemini-test:streamGenerateContent?alt=sse');
    assert.equal(sent.headers?.['x-goog-api-key'], 'test-key');
    assert.equal(sent.body?.generationConfig?.maxOutputTokens, 1024);
    assert.equal(sent.body?.tools?.[0]?.functionDeclarations?.[0]?.name, 'read');
    assert.equal(result.text, 'Let me look.');
    assert.equal(result.reasoning, 'Thinking.');
    assert.equal(result.finishReason, 'STOP');
    assert.deepEqual(result.toolCalls[0]?.arguments, { path: 'hello.txt' });
    assert.equal(result.usage.inputTokens, 72);
    assert.equal(result.usage.outputTokens, 9);
    assert.equal(result.usage.reasoningTokens, 4);
    assert.equal(result.usage.cacheReadTokens, 8);
    assert.deepEqual(text, ['Let me look.']);
    assert.deepEqual(reasoning, ['Thinking.']);
  });

  test('Google replays a thought signature attached to an empty text part', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      if (calls === 1) {
        sse(response, [
          {
            data: JSON.stringify({
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
          }
        ]);
        return;
      }
      sse(response, [
        {
          data: JSON.stringify({
            candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }]
          })
        }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    const model = modelFor(provider, 'gemini-test');
    const { request } = requestFor(provider, model);
    const first = await streamChat(request);

    assert.deepEqual(first.providerParts, [
      { text: '', thoughtSignature: 'sig-empty' },
      { functionCall: { name: 'read', args: { path: 'hello.txt' } } }
    ]);
    const call = first.toolCalls[0]!;

    const { request: second } = requestFor(provider, model, {
      messages: [
        { role: 'user', content: 'read hello.txt' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [call],
          providerParts: first.providerParts
        },
        { role: 'tool', toolCallId: call.id, name: 'read', content: 'hello' }
      ]
    });
    await streamChat(second);

    const contents = captured.at(-1)?.body?.contents as Array<Record<string, any>>;
    const modelTurn = contents.find((entry) => entry.role === 'model');
    assert.deepEqual(modelTurn?.parts?.[0], { text: '', thoughtSignature: 'sig-empty' });
    assert.deepEqual(modelTurn?.parts?.[1], {
      functionCall: { name: 'read', args: { path: 'hello.txt' } }
    });
  });

  test('OpenAI sends reasoning_effort for reasoning models', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    const model = modelFor(provider, 'gpt-5-test');
    model.meta = { id: model.id, name: model.name, tool_call: true, reasoning: true };
    const { request } = requestFor(provider, model);
    request.options = { ...request.options, maxTokens: 8_192, effort: 'high' };
    await streamChat(request);

    const body = captured.at(-1)?.body;
    assert.equal(body?.reasoning_effort, 'high');
    assert.equal(body?.max_completion_tokens, 8_192);
  });

  test('OpenRouter wraps effort in its reasoning object', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openrouter', 'openai', baseURL, { authorization: 'Bearer test-key' });
    const model = modelFor(provider, 'free-reasoner');
    model.meta = { id: model.id, name: model.name, tool_call: true, reasoning: true };
    const { request } = requestFor(provider, model);
    request.options = { ...request.options, effort: 'low' };
    await streamChat(request);

    assert.deepEqual(captured.at(-1)?.body?.reasoning, { effort: 'low' });
    assert.equal(captured.at(-1)?.body?.reasoning_effort, undefined);
  });

  test('Anthropic maps effort to thinking and replays signed blocks', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: 'Let me ' }
          })
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking: 'think.' }
          })
        },
        {
          event: 'content_block_delta',
          data: JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig-stream' }
          })
        },
        {
          event: 'content_block_start',
          data: JSON.stringify({
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'text', text: 'done' }
          })
        },
        { event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) }
      ]);
    });
    const provider = providerFor('anthropic', 'anthropic', baseURL, {
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01'
    });
    const model = modelFor(provider, 'claude-test');
    model.meta = { id: model.id, name: model.name, tool_call: true, reasoning: true };
    const { request } = requestFor(provider, model, {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: 'hello',
          thinkingBlocks: [{ thinking: 'prior thought', signature: 'sig-prior' }]
        },
        { role: 'user', content: 'read hello.txt' }
      ]
    });
    request.options = { ...request.options, maxTokens: 8_192, effort: 'high' };
    const result = await streamChat(request);

    const body = captured.at(-1)?.body;
    assert.deepEqual(body?.thinking, { type: 'enabled', budget_tokens: 7_168 });
    const assistant = body?.messages?.find((message: any) => message.role === 'assistant');
    assert.deepEqual(assistant?.content?.[0], {
      type: 'thinking',
      thinking: 'prior thought',
      signature: 'sig-prior'
    });
    assert.equal(result.thinkingBlocks?.[0]?.signature, 'sig-stream');
  });

  test('Google 2.5 maps effort to a thinking budget and hides thoughts by default', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    const model = modelFor(provider, 'gemini-2.5-pro');
    model.meta = { id: model.id, name: model.name, tool_call: true, reasoning: true };
    const { request } = requestFor(provider, model);
    request.options = { ...request.options, maxTokens: 8_192, effort: 'medium' };
    await streamChat(request);

    assert.deepEqual(captured.at(-1)?.body?.generationConfig?.thinkingConfig, {
      thinkingBudget: 7_680
    });
  });

  test('Google 3 uses thinkingLevel, with minimal for Flash-Lite on low effort', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    const lite = modelFor(provider, 'gemini-3.1-flash-lite-preview');
    lite.meta = { id: lite.id, name: lite.name, tool_call: true, reasoning: true };
    const liteRequest = requestFor(provider, lite).request;
    liteRequest.options = { ...liteRequest.options, maxTokens: 8_192, effort: 'low' };
    await streamChat(liteRequest);
    assert.deepEqual(captured.at(-1)?.body?.generationConfig?.thinkingConfig, {
      thinkingLevel: 'minimal'
    });

    const flash = modelFor(provider, 'gemini-3-flash-preview');
    flash.meta = { id: flash.id, name: flash.name, tool_call: true, reasoning: true };
    const flashRequest = requestFor(provider, flash).request;
    flashRequest.options = {
      ...flashRequest.options,
      maxTokens: 8_192,
      effort: 'medium',
      showReasoning: true
    };
    await streamChat(flashRequest);
    assert.deepEqual(captured.at(-1)?.body?.generationConfig?.thinkingConfig, {
      thinkingLevel: 'medium',
      includeThoughts: true
    });
  });

  test('Google 2.5 Flash can fully disable thinking on low effort', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    const model = modelFor(provider, 'gemini-2.5-flash');
    model.meta = { id: model.id, name: model.name, tool_call: true, reasoning: true };
    const { request } = requestFor(provider, model);
    request.options = { ...request.options, maxTokens: 8_192, effort: 'low' };
    await streamChat(request);

    assert.deepEqual(captured.at(-1)?.body?.generationConfig?.thinkingConfig, {
      thinkingBudget: 0
    });
  });

  test('Azure builds deployment URLs with API versions', () => {
    const provider = providerFor('azure', 'azure', 'https://example.openai.azure.com', {
      'api-key': 'test-key'
    });
    provider.settings = { deployment: 'prod-gpt', apiVersion: '2024-12-01-preview' };
    const model = modelFor(provider, 'gpt-4o');
    assert.equal(
      azureChatUrl(requestFor(provider, model).request),
      'https://example.openai.azure.com/openai/deployments/prod-gpt/chat/completions?api-version=2024-12-01-preview'
    );

    provider.baseURL = 'https://example.openai.azure.com/openai';
    assert.equal(
      azureChatUrl(requestFor(provider, model).request),
      'https://example.openai.azure.com/openai/deployments/prod-gpt/chat/completions?api-version=2024-12-01-preview'
    );

    provider.baseURL =
      'https://example.openai.azure.com/openai/deployments/prod-gpt/chat/completions?api-version=2024-01-01';
    assert.equal(
      azureChatUrl(requestFor(provider, model).request),
      'https://example.openai.azure.com/openai/deployments/prod-gpt/chat/completions?api-version=2024-01-01'
    );
  });

  test('OpenAI dialect maps history and tool messages correctly', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        {
          data: JSON.stringify({
            choices: [
              {
                delta: { content: 'done' },
                finish_reason: 'stop'
              }
            ],
            usage: { prompt_tokens: 20, completion_tokens: 2 }
          })
        },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    const model = modelFor(provider, 'gpt-test');
    const { request, text } = requestFor(provider, model, {
      messages: [
        { role: 'user', content: 'read hello.txt' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'hello.txt' } }]
        },
        { role: 'tool', toolCallId: 'call_1', name: 'read', content: 'hello' }
      ]
    });
    const result = await streamChat(request);

    const sent = captured.at(-1)!;
    assert.equal(sent.url, '/chat/completions');
    assert.equal(sent.headers?.authorization, 'Bearer test-key');
    assert.equal(sent.body?.messages?.[0]?.role, 'system');
    assert.equal(sent.body?.messages?.[2]?.tool_calls?.[0]?.function?.name, 'read');
    assert.equal(sent.body?.messages?.[3]?.tool_call_id, 'call_1');
    assert.equal(sent.body?.stream_options?.include_usage, true);
    assert.equal(result.text, 'done');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(result.usage.outputTokens, 2);
    assert.deepEqual(text, ['done']);
  });

  test('OpenAI usage keeps cached, cache-write, and reasoning fields', async () => {
    const baseURL = await serve((_request, response) => {
      sse(response, [
        {
          data: JSON.stringify({
            choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }]
          })
        },
        {
          data: JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              prompt_tokens_details: {
                cached_tokens: 40,
                cache_creation_tokens: 5
              },
              completion_tokens_details: { reasoning_tokens: 7 }
            }
          })
        },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('deepseek', 'openai', baseURL, { authorization: 'Bearer test-key' });
    const model = modelFor(provider, 'deepseek-test');
    const { request } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(result.usage.inputTokens, 100);
    assert.equal(result.usage.outputTokens, 20);
    assert.equal(result.usage.cacheReadTokens, 40);
    assert.equal(result.usage.cacheWriteTokens, 5);
    assert.equal(result.usage.reasoningTokens, 7);
    assert.equal(captured.at(-1)?.body?.stream_options?.include_usage, true);
  });

  test('HTTP retries happen before a stream starts and reuse an idempotency key', async () => {
    let calls = 0;
    const keys: string[] = [];
    const baseURL = await serve((request, response) => {
      calls += 1;
      keys.push(String(request.headers['idempotency-key']));
      if (calls === 1) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'temporary' } }));
        return;
      }
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 1, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(calls, 2);
    assert.equal(result.text, 'recovered');
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1]);
  });

  test('fails a quota 429 once with a short message instead of retrying for a minute', async () => {
    let calls = 0;
    const repeated =
      'You exceeded your current quota for this model. Please check your plan and billing details. ' +
      'Quota metric: generate_content_free_tier_requests. Limit: 0.';
    const baseURL = await serve((_request, response) => {
      calls += 1;
      response.writeHead(429, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 429,
            status: 'RESOURCE_EXHAUSTED',
            message: `${repeated} ${repeated} ${repeated}`
          }
        })
      );
    });
    const provider = providerFor('google', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 4, retryDelay: 1 };
    const model = modelFor(provider, 'gemini-test');
    const { request } = requestFor(provider, model);

    await assert.rejects(
      () => streamChat(request),
      (error: unknown) => {
        assert.ok(error instanceof SurfError);
        assert.equal(error.status, 429);
        assert.equal(error.retryable, false);
        assert.match(error.message, /RESOURCE_EXHAUSTED|quota/i);
        assert.ok(error.message.length < 320, `message should be compact: ${error.message}`);
        assert.match(error.hint ?? '', /Switch models/);
        return true;
      }
    );
    assert.equal(calls, 1);
  });

  test('retries a request timeout that happens before any content', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.on('error', () => {});
        setTimeout(() => response.destroy(), 1_200);
        return;
      }
      sse(response, [
        {
          data: JSON.stringify({
            choices: [{ delta: { content: 'after timeout' }, finish_reason: 'stop' }]
          })
        },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 1, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request } = requestFor(provider, model, {
      options: { signal: new AbortController().signal, maxTokens: 1024, timeout: 300 }
    });
    const result = await streamChat(request);

    assert.equal(calls, 2);
    assert.equal(result.text, 'after timeout');
  });

  test('retries a stream that dies before any content arrives', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      if (calls === 1) {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        response.write(': keepalive\n\n');
        response.destroy();
        return;
      }
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'second try' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 1, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request, text } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(calls, 2);
    assert.equal(result.text, 'second try');
    assert.deepEqual(text, ['second try']);
  });

  test('retries a completed response that contains no text or tool calls', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      if (calls === 1) {
        sse(response, [
          { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
          { data: '[DONE]' }
        ]);
        return;
      }
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'after retry' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 1, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request, text } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(calls, 2);
    assert.equal(result.text, 'after retry');
    assert.deepEqual(text, ['after retry']);
  });

  test('reports a persistent empty reply with the finish reason instead of stopping silently', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 1, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request } = requestFor(provider, model);

    await assert.rejects(
      () => streamChat(request),
      (error: unknown) => {
        assert.ok(error instanceof SurfError);
        assert.match(error.message, /returned an empty reply/i);
        assert.match(error.message, /finish reason: stop/i);
        assert.match(error.hint ?? '', /switch models|try again/i);
        return true;
      }
    );
    assert.equal(calls, 2);
  });

  test('returns Google MAX_TOKENS with no visible text for agent diagnostics', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      sse(response, [
        {
          data: JSON.stringify({
            candidates: [
              {
                content: { parts: [] },
                finishReason: 'MAX_TOKENS'
              }
            ],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 0, thoughtsTokenCount: 96 }
          })
        }
      ]);
    });
    const provider = providerFor('google', 'google', baseURL, { 'x-goog-api-key': 'test-key' });
    provider.settings = { retries: 2, retryDelay: 1 };
    const model = modelFor(provider, 'gemini-test');
    const { request } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(calls, 1);
    assert.equal(result.finishReason, 'MAX_TOKENS');
    assert.equal(result.text, '');
    assert.equal(result.usage.reasoningTokens, 96);
  });

  test('does not replay a stream after partial text reached the UI', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' }, finish_reason: null }] })}\n\n`
      );
      setTimeout(() => response.destroy(), 10);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 2, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const { request } = requestFor(provider, model);

    await assert.rejects(() => streamChat(request));
    assert.equal(calls, 1);
  });

  test('stops an in-flight stream when its signal is aborted', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response) => {
      calls += 1;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'first' }, finish_reason: null }] })}\n\n`
      );
      setTimeout(() => response.end(), 500);
    });
    const provider = providerFor('openai', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 2, retryDelay: 1 };
    const model = modelFor(provider, 'gpt-test');
    const controller = new AbortController();
    const { request, text } = requestFor(provider, model, {
      options: { signal: controller.signal, maxTokens: 1024 },
      callbacks: {
        onText: (delta) => {
          text.push(delta);
          controller.abort();
        },
        onReasoning: () => {}
      }
    });

    await assert.rejects(() => streamChat(request));
    assert.equal(controller.signal.aborted, true);
    assert.equal(calls, 1);
    assert.deepEqual(text, ['first']);
  });

  test('falls back when an OpenAI-compatible server rejects include_usage', async () => {
    let calls = 0;
    const baseURL = await serve((_request, response, body) => {
      calls += 1;
      if (body.stream_options) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Unsupported parameter: stream_options' } }));
        return;
      }
      sse(response, [
        { data: JSON.stringify({ choices: [{ delta: { content: 'no usage option' }, finish_reason: 'stop' }] }) },
        { data: '[DONE]' }
      ]);
    });
    const provider = providerFor('legacy', 'openai', baseURL, { authorization: 'Bearer test-key' });
    provider.settings = { retries: 0, retryDelay: 1 };
    const model = modelFor(provider, 'legacy-chat');
    const { request } = requestFor(provider, model);
    const result = await streamChat(request);

    assert.equal(calls, 2);
    assert.equal(result.text, 'no usage option');
    assert.equal(captured.at(-1)?.body?.stream_options, undefined);
  });
});
