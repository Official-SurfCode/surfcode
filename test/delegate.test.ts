import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { createDelegateTool } from '../src/core/delegate.js';
import type {
  AgentDelegate,
  ResolvedModel,
  ResolvedProvider,
  Usage
} from '../src/core/types.js';

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

async function serve(
  name: string,
  starts: number[],
  barrier: Promise<void>
): Promise<string> {
  const server = createServer(async (_request, response) => {
    starts.push(Date.now());
    // Both workers must be allowed to start before either is answered. The
    // timeout keeps a sequential implementation from hanging the suite.
    await Promise.race([barrier, new Promise((resolve) => setTimeout(resolve, 1_500))]);
    writeSse(response, name);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function writeSse(response: ServerResponse, name: string): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive'
  });
  response.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: `${name} answer` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 }
    })}\n\n`
  );
  response.write('data: [DONE]\n\n');
  response.end();
}

function provider(id: string, baseURL: string): ResolvedProvider {
  return {
    id,
    name: id,
    dialect: 'openai',
    baseURL,
    apiKey: 'test-key',
    headers: { authorization: 'Bearer test-key' },
    settings: { retries: 0 },
    keyless: false
  };
}

function model(owner: ResolvedProvider, id: string): ResolvedModel {
  return {
    id,
    name: id,
    provider: owner,
    contextWindow: 128_000,
    maxOutput: 8_192,
    meta: { id, name: id, tool_call: true }
  };
}

test('delegate starts every worker before any worker resolves and merges usage', async () => {
  const starts: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = provider('alpha', await serve('alpha', starts, barrier));
  const second = provider('beta', await serve('beta', starts, barrier));

  const watcher = setInterval(() => {
    if (starts.length === 2) release();
  }, 5);

  const delegates: AgentDelegate[] = [
    { provider: first, model: model(first, 'alpha-one') },
    { provider: second, model: model(second, 'beta-one') }
  ];
  const usage: Usage[] = [];
  const tool = createDelegateTool({
    delegates,
    getHistory: () => [{ role: 'user', content: 'review the plan' }],
    signal: new AbortController().signal,
    cwd: '/tmp/project',
    maxTokens: 4_096,
    onUsage: (delta) => usage.push(delta as Usage)
  });

  const started = Date.now();
  const result = await tool.execute(
    {
      tasks: [
        { worker: 'alpha/alpha-one', task: 'Check the API design.' },
        { worker: 'beta/beta-one', task: 'Find edge cases.' }
      ]
    },
    {
      cwd: '/tmp/project',
      signal: new AbortController().signal,
      allowOutsideWorkspace: false,
      planMode: false,
      requestPermission: async () => 'allow'
    }
  );
  clearInterval(watcher);
  const elapsed = Date.now() - started;

  assert.equal(starts.length, 2);
  assert.ok(
    Math.abs(starts[0]! - starts[1]!) < 200,
    `workers started ${Math.abs(starts[0]! - starts[1]!)}ms apart; delegation ran sequentially`
  );
  assert.ok(elapsed < 1_400, `delegation took ${elapsed}ms`);
  assert.equal(result.isError, false);
  assert.match(result.output, /### alpha\/alpha-one\nalpha answer/);
  assert.match(result.output, /### beta\/beta-one\nbeta answer/);
  assert.match(result.display?.summary ?? '', /2 workers/);
  assert.equal(usage.length, 2);
  assert.equal(usage[0]!.inputTokens + usage[1]!.inputTokens, 80);
  assert.equal(usage[0]!.outputTokens + usage[1]!.outputTokens, 20);
});

test('delegate rejects an empty task list', async () => {
  const owner = provider('solo', 'http://127.0.0.1:9');
  const tool = createDelegateTool({
    delegates: [{ provider: owner, model: model(owner, 'solo-one') }],
    getHistory: () => [],
    signal: new AbortController().signal,
    cwd: '/tmp/project',
    maxTokens: 1_024
  });
  const result = await tool.execute(
    { tasks: [] },
    {
      cwd: '/tmp/project',
      signal: new AbortController().signal,
      allowOutsideWorkspace: false,
      planMode: false,
      requestPermission: async () => 'allow'
    }
  );
  assert.equal(result.isError, true);
  assert.match(result.output, /No delegation tasks/);
});
